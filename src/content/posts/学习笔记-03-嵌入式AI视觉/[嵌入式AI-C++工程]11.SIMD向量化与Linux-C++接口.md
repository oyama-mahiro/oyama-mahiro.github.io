---
title: '[嵌入式AI-C++工程] SIMD向量化与Linux-C++接口'
published: 2026-09-24T08:43:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍SIMD向量化与Linux-C++接口的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-11 SIMD向量化与Linux C++接口

单指令多数据流（Single Instruction, Multiple Data，SIMD）让CPU用一条向量指令同时处理多个同类型数据。它主要用于数组运算、图像像素处理、颜色空间转换和神经网络预处理等重复计算。

本章先说明SIMD怎样在CPU核心内部工作，再介绍Linux C++中常用的ARM NEON接口、线程绑核方法和编译方式，最后分别用数组乘加和NV12转RGB观察完整的向量计算过程。

## 1 SIMD的核心概念

### 1.1 SIMD的基本运作机制

普通标量循环一次处理一个元素。例如，下面的加法需要分别计算四次：

```text
result[0] = left[0] + right[0]
result[1] = left[1] + right[1]
result[2] = left[2] + right[2]
result[3] = left[3] + right[3]
```

SIMD先把多个元素装入向量寄存器，再让一条向量加法指令作用到所有数据通道（Lane）：

```text
left_vector   = [left0, left1, left2, left3]
right_vector  = [right0, right1, right2, right3]
result_vector = [left0 + right0,
                 left1 + right1,
                 left2 + right2,
                 left3 + right3]
```

一次SIMD计算通常经历四步：

```text
普通内存中的连续数据
        ↓ 向量加载指令
CPU核心中的向量寄存器
        ↓ 向量算术或逻辑指令
保存多个计算结果的向量寄存器
        ↓ 向量存储指令
普通内存中的输出数据
```

一个CPU核心具有多组架构可见的向量寄存器。程序运行到向量指令时，编译器使用这些寄存器保存输入、中间结果和输出。多个向量寄存器允许CPU在一次计算中同时保留多批数据。

### 1.2 SIMD与GPU SIMT的区别

GPU常用单指令多线程（Single Instruction, Multiple Threads，SIMT）组织并行计算。SIMD与SIMT都适合让大量数据执行相似计算，但它们的执行单位不同。

| 对比项 | CPU SIMD | GPU SIMT |
| --- | --- | --- |
| 基本执行单位 | 一个CPU线程中的一条向量指令 | 由多个GPU线程组成的线程束 |
| 并行规模 | 单条指令通常处理几个到几十个元素 | 一个任务可以包含成千上万个线程 |
| 数据位置 | CPU缓存和主存 | GPU显存或统一内存体系 |
| 控制方式 | C++循环、自动向量化或Intrinsic | GPU Kernel、线程网格和线程块 |
| 适合工作量 | 中小规模低延迟处理、已有CPU流水线 | 大规模、计算密集且并行度高的任务 |

CPU SIMD仍然运行在普通CPU线程中，可以直接读取进程地址空间里的数组。GPU程序还需要建立GPU任务，并处理线程组织以及CPU与GPU之间的数据关系。对于单帧图像中的简单颜色转换，如果数据本来就在CPU内存中，SIMD可以避免一次额外的设备传输。

### 1.3 SIMD适合和不适合的计算

SIMD最适合多个元素执行相同且相互独立的计算，例如：

- 数组逐元素加减、乘法和乘加；
- 图像亮度调整、阈值处理和颜色转换；
- 输入张量的减均值和缩放；
- 多个音频采样的格式转换；
- 多个整数同时执行比较、最小值或最大值运算。

数据顺序仍然会影响性能。连续存放的数据可以直接装入一个向量，分散在多个地址的数据需要额外收集或重排。

下面几种情况会降低SIMD收益：

1. 当前元素必须等待前一个元素的计算结果。
2. 不同元素需要执行大量不同分支。
3. 输入数据不连续，向量加载前要频繁整理。
4. 计算过程中经常需要把不同Lane合并成一个值。
5. 数据量很小，加载、重排和尾部处理占据主要时间。

存在前后依赖的算法有时可以重新组织为分块计算，但实现会增加额外指令。实际工程应当先用阶段1-10的方法确认热点，再决定是否手写SIMD。

## 2 向量寄存器容量与多线程协同

### 2.1 向量寄存器容量与Lane划分

ARM NEON主要使用128位向量，x86 AVX2可以使用256位向量。同一个寄存器能够装多少个元素，由元素自身的位宽决定：

\[
\text{Lane数量}=\frac{\text{向量位宽}}{\text{单个元素位宽}}
\]

| 向量规格 | 8位整数 | 16位整数 | 32位整数或浮点数 | 64位数据 |
| --- | ---: | ---: | ---: | ---: |
| NEON 128位 | 16 | 8 | 4 | 2 |
| AVX2 256位 | 32 | 16 | 8 | 4 |

例如，`uint8x16_t`表示16个无符号8位整数，`float32x4_t`表示4个32位浮点数。它们占用的向量总宽度都是128位，但每条算术指令处理的元素数量不同。

按位AND、OR和XOR可以一次作用到完整的128位数据。如果程序把数据解释为16个8位整数，算术并行度就是16个Lane；“一次处理128位”和“128路算术并行”表达的是不同概念。

使用NEON这类固定宽度SIMD时，传给向量指令的操作数始终是完整向量。例如，`float32x4_t`固定包含4个`float` Lane，`vaddq_f32()`也一定会计算4组加法。四个Lane都存在，但不要求四个Lane都代表最终需要的有效数据。

假设数组末尾只剩3个`float`，有两种常用处理方法：

1. **使用标量尾部循环**：前三个元素继续用普通加法处理。这种方法最直接，也是本文Demo采用的方式。
2. **安全补满4个Lane**：把三个有效元素复制到一个长度为4的临时数组，在第4个位置填入`0`等不会影响目标结果的占位值，再执行向量加载和计算。保存结果后只取前3个Lane，第4个结果直接忽略。

```cpp
// 原始输入只有3个有效float，不能直接对它调用vld1q_f32()读取4个元素。
const float input[3] = {1.0F, 2.0F, 3.0F};

// 临时数组提供完整的4个float存储空间；最后一个0只是占位值。
const float padded_input[4] = {input[0], input[1], input[2], 0.0F};
const float32x4_t input_vector = vld1q_f32(padded_input);

// SIMD指令仍会计算全部4个Lane。
const float32x4_t result_vector = vaddq_f32(input_vector, input_vector);

float padded_result[4];
vst1q_f32(padded_result, result_vector);

// padded_result[0～2]是有效结果，padded_result[3]对应占位Lane，不再使用。
```

需要注意的是，不能让`vld1q_f32()`直接读取一个实际只剩3个有效元素的缓冲区。该接口会从指针位置读取完整的16字节，也就是4个`float`；第四个元素不属于有效对象时会造成越界读取。向量“补满”必须使用真实存在且可以安全访问的存储空间。

### 2.2 向量寄存器数量与CPU核心数量的关系

AArch64指令集为每个线程的架构状态定义了32个128位SIMD与浮点寄存器，名称为`V0～V31`。这里的“32个”来自AArch64体系结构，不是Linux规定的数量。线程运行在某个CPU核心上时，可以使用这一整组架构寄存器；线程被切换出去后，Linux内核负责在需要时保存它的寄存器状态，并在它再次运行前恢复。

需要区分三个数量：

- **向量寄存器数量**：AArch64程序可以看到32个`V`寄存器，每个宽128位。
- **CPU核心数量**：决定多少个线程能够真正分布到不同核心并行运行。例如，8个物理核心可以同时执行来自多个线程的工作。
- **每个核心内部的向量执行流水线数量**：决定一个核心每个周期能够接收或完成多少条向量指令，具体数量由Cortex-A55、Cortex-A76等微架构决定，不能用32个寄存器或CPU核心总数推算。

以两个输入向量相加并产生一个输出向量为例，编译器可以把它们放到三个向量寄存器中：

```text
V0 = [a0, a1, a2, a3]   第一个输入
V1 = [b0, b1, b2, b3]   第二个输入
V2 = V0 + V1            输出结果
```

假设当前线程运行在CPU核心3，这条向量加法就由核心3内部的NEON执行流水线执行。`V0`、`V1`和`V2`保存操作数与结果，三个寄存器不会让一次加法分散到三个CPU核心。编译器也可能复用寄存器，因此最终机器码中的实际寄存器编号以反汇编结果为准。

```text
一个线程
    ↓ 被Linux调度到CPU核心3
该线程的V0、V1保存两个输入
    ↓ 核心3的NEON执行流水线执行向量加法
该线程的V2保存一个输出
```

从程序角度看，每个正在运行的线程都有自己的一组`V0～V31`值。从硬件角度看，CPU实现还可能通过寄存器重命名使用更多内部物理寄存器，这些物理细节不会直接暴露给NEON Intrinsics。AArch64的32个128位寄存器定义可参考[Arm的ARMv8-A体系结构资料](https://developer.arm.com/-/media/Files/pdf/graphics-and-multimedia/ARM_CPU_Architecture.pdf)。

### 2.3 多线程与SIMD的组合

多线程让不同CPU核心同时处理不同数据块，SIMD让每个线程在自己的CPU核心中一次处理多个元素。两者可以叠加：

```text
一帧图像
├── 线程0处理第0～269行   → 每次用NEON处理16个像素
├── 线程1处理第270～539行 → 每次用NEON处理16个像素
├── 线程2处理第540～809行 → 每次用NEON处理16个像素
└── 线程3处理第810～1079行→ 每次用NEON处理16个像素
```

每个线程具有独立的架构运行状态，包括该线程当前使用的通用寄存器和向量寄存器值。线程被切出CPU时，内核会在需要时保存它的寄存器状态；该线程恢复运行前，内核再恢复对应状态。

多个计算密集线程绑定到同一个逻辑CPU时只能轮流获得执行时间，通常无法增加吞吐量。它们仍然可以正确运行，只是会产生时间片切换并竞争同一套核心执行资源。计算密集型任务通常让工作线程分布到不同CPU核心，再根据缓存、内存带宽和大小核性能测试确定线程数。

## 3 Linux C++线程绑定CPU核心

### 3.1 CPU亲和性的作用

CPU亲和性（CPU Affinity）规定线程允许在哪些逻辑CPU上运行。例如，把一个工作线程的亲和性集合设为CPU 4，就会限制该线程只能在逻辑CPU 4上运行。

绑核可以减少线程在不同CPU之间迁移，进而减少缓存重新填充带来的波动。它不会独占CPU 4，操作系统仍然可以把其他允许使用CPU 4的任务调度到同一核心。

在RK3588等大小核设备上，逻辑CPU编号与核心类型的对应关系应当从系统查询：

```bash
# 查看逻辑CPU、核心编号、集群和在线状态。
lscpu -e=CPU,CORE,SOCKET,ONLINE,MAXMHZ,MINMHZ

# 查看每个CPU对应的实现者、架构和部件编号。
grep -E 'processor|CPU implementer|CPU part' /proc/cpuinfo
```

不能把“较大的CPU编号一定是大核”写成通用规则。板级设备树、内核和固件决定系统如何呈现CPU编号。

### 3.2 Linux线程绑核API

Linux glibc提供以下线程亲和性接口：

```cpp
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>

int pthread_setaffinity_np(
    pthread_t thread,
    size_t cpusetsize,
    const cpu_set_t* cpuset);

int pthread_getaffinity_np(
    pthread_t thread,
    size_t cpusetsize,
    cpu_set_t* cpuset);
```

参数含义如下：

- `thread`指定需要设置或查询的线程；
- `cpusetsize`一般传入`sizeof(cpu_set_t)`；
- `cpuset`指向CPU集合；
- 成功返回0，失败直接返回错误编号。

`CPU_ZERO()`先清空集合，`CPU_SET(cpu_index, &set)`再加入允许使用的逻辑CPU。`pthread_setaffinity_np()`成功后，如果线程当前位于集合之外，内核会把它迁移到集合中的某个CPU。该接口的完整语义与错误条件见[`pthread_setaffinity_np(3)`](https://man7.org/linux/man-pages/man3/pthread_setaffinity_np.3.html)。

### 3.3 `std::thread`绑定CPU核心

下面的函数在线程内部绑定当前线程，并立即查询内核最终接受的亲和性集合。Pthreads函数直接返回错误编号，因此错误文本使用`std::strerror(error_code)`，不能只读取`errno`。

```cpp
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>

#include <cstring>
#include <iostream>
#include <thread>

// 将调用该函数的当前线程限制到一个逻辑CPU。
// cpu_index是Linux逻辑CPU编号；返回true表示设置和查询均成功。
bool bind_current_thread_to_cpu(int cpu_index)
{
    cpu_set_t requested_set;
    CPU_ZERO(&requested_set);
    CPU_SET(cpu_index, &requested_set);

    // pthread_self()取得当前工作线程自己的pthread_t。
    // 函数成功后，线程可运行CPU集合被限制为requested_set。
    const int set_error = pthread_setaffinity_np(
        pthread_self(), sizeof(requested_set), &requested_set);
    if (set_error != 0) {
        std::cerr << "pthread_setaffinity_np failed: "
                  << std::strerror(set_error) << '\n';
        return false;
    }

    cpu_set_t actual_set;
    CPU_ZERO(&actual_set);
    const int get_error = pthread_getaffinity_np(
        pthread_self(), sizeof(actual_set), &actual_set);
    if (get_error != 0) {
        std::cerr << "pthread_getaffinity_np failed: "
                  << std::strerror(get_error) << '\n';
        return false;
    }

    // CPU_ISSET验证内核返回的集合中是否包含目标CPU。
    // sched_getcpu()只表示线程打印这一行时正在哪个CPU上运行。
    std::cout << "target CPU=" << cpu_index
              << ", allowed=" << CPU_ISSET(cpu_index, &actual_set)
              << ", current CPU=" << sched_getcpu() << '\n';
    return CPU_ISSET(cpu_index, &actual_set);
}

int main()
{
    std::thread worker([] {
        if (!bind_current_thread_to_cpu(2)) {
            return;
        }

        // 实际项目在这里处理分配给该线程的数据块，
        // 线程内部可以继续调用NEON向量化函数。
    });

    worker.join();
    return 0;
}
```

编译时使用`-pthread`同时启用编译和链接所需的线程支持：

```bash
g++ -std=c++17 -O2 -pthread affinity_demo.cpp -o affinity_demo
./affinity_demo
```

如果程序受到容器、cgroup或cpuset限制，内核最终允许的CPU集合可能小于程序请求的集合。查询返回值才是当前线程实际可以使用的CPU集合。

## 4 Linux C++调用SIMD接口

### 4.1 自动向量化与Intrinsics

Linux C++有两种常见的SIMD编程方式。

第一种方式是编写普通循环，让GCC或Clang自动向量化：

```cpp
for (std::size_t index = 0; index < count; ++index) {
    output[index] = input[index] * scale;
}
```

编译器会分析循环依赖、指针别名、数据类型和目标CPU。如果能够证明多个迭代可以并行执行，编译器可能生成向量指令。

GCC可以输出向量化报告：

```bash
# 显示成功向量化的循环。
g++ -O3 -fopt-info-vec-optimized source.cpp

# 显示循环未被向量化的原因。
g++ -O3 -fopt-info-vec-missed source.cpp
```

第二种方式是使用Intrinsic。Intrinsic是编译器提供的C/C++函数式接口，通常对应一条或一组CPU指令。ARM NEON代码包含`<arm_neon.h>`，x86 AVX2代码包含`<immintrin.h>`。

手写Intrinsic能够明确控制加载、计算和写回，但代码与指令集架构绑定。项目仍应保留标量实现，用于不支持该指令集的CPU以及结果对照。

### 4.2 ARM NEON的数据类型

NEON类型名同时写出了元素类型、元素位宽和Lane数量：

| NEON类型 | 保存的数据 |
| --- | --- |
| `uint8x16_t` | 16个无符号8位整数 |
| `int16x8_t` | 8个有符号16位整数 |
| `int32x4_t` | 4个有符号32位整数 |
| `float32x4_t` | 4个32位浮点数 |

例如，`uint8x16_t`可以保存16个灰度像素；`float32x4_t`可以保存4个归一化后的浮点数。后缀中的`q`通常表示使用128位向量版本，例如`vaddq_f32()`处理`float32x4_t`。

### 4.3 NEON数据加载与存储API

`vld1q_*()`从普通内存连续加载一个128位向量，`vst1q_*()`把向量写回内存：

```cpp
#include <arm_neon.h>

void add_four_floats(const float* left,
                     const float* right,
                     float* output)
{
    // 每个加载接口从指针起始位置读取4个连续float，共16字节。
    const float32x4_t left_vector = vld1q_f32(left);
    const float32x4_t right_vector = vld1q_f32(right);

    // 四个Lane分别相加，Lane之间不会互相传递结果。
    const float32x4_t result_vector =
        vaddq_f32(left_vector, right_vector);

    // 从output开始连续写入4个float。
    vst1q_f32(output, result_vector);
}
```

交错接口用于拆分或组合多通道数据。`vld2_u8()`从内存读取16个字节，并分别返回偶数位置和奇数位置的8个字节；对于`U0,V0,U1,V1...`排列，它可以直接得到一组U和一组V。`vst3q_u8()`则把三个16字节向量按`R0,G0,B0,R1,G1,B1...`写回内存。

这些接口的精确参数、返回类型和架构支持范围可在[Arm Neon Intrinsics Reference](https://arm-software.github.io/acle/neon_intrinsics/advsimd.html)中查询。

### 4.4 NEON算术与逻辑计算API

Intrinsic名称通过后缀区分数据类型。例如：

| 操作 | 无符号8位整数 | 有符号16位整数 | 32位浮点数 |
| --- | --- | --- | --- |
| 加法 | `vaddq_u8` | `vaddq_s16` | `vaddq_f32` |
| 减法 | `vsubq_u8` | `vsubq_s16` | `vsubq_f32` |
| 乘法 | `vmulq_u8` | `vmulq_s16` | `vmulq_f32` |
| 最大值 | `vmaxq_u8` | `vmaxq_s16` | `vmaxq_f32` |
| 最小值 | `vminq_u8` | `vminq_s16` | `vminq_f32` |

乘加接口可以把乘法结果直接加到累加向量：

```cpp
// 计算result = addend + value * scale。
const float32x4_t result =
    vmlaq_f32(addend, value, scale);
```

`vandq_*()`、`vorrq_*()`和`veorq_*()`分别完成按位AND、OR和XOR。比较接口通常返回每个Lane全0或全1的掩码，后续可以用选择接口根据掩码从两个向量中选择数据。

### 4.5 数据扩展、饱和与收窄API

8位像素只表示`0～255`。YUV转RGB包含乘法和带符号减法，中间结果可能小于0或大于255，因此需要扩大中间类型：

```text
uint8像素
  ↓ 扩展
int16中间值
  ↓ 再扩展并执行乘法
int32计算结果
  ↓ 移位并饱和收窄
uint8 RGB像素
```

常用接口包括：

- `vmovl_u8()`：把8个`uint8`扩展为8个`uint16`；
- `vmovl_s16()`：把4个`int16`扩展为4个`int32`；
- `vqmovn_s32()`：把4个`int32`饱和收窄为4个`int16`；
- `vqmovun_s16()`：把8个有符号16位数饱和收窄为无符号8位数。

`vqmovun_s16()`会把负值变成0，把大于255的值变成255。普通强制类型转换只保留低位，可能把256变成0，因此图像输出通常需要饱和收窄。

### 4.6 SIMD循环的尾部处理

向量循环一次处理固定数量的数据。假设`float32x4_t`每次处理4个元素，长度为10的数组需要这样划分：

```text
第1次向量循环：元素0～3
第2次向量循环：元素4～7
标量尾部循环：元素8～9
```

常用循环条件是`index + lane_count <= count`。它保证每次向量加载都位于有效缓冲区内。即使程序最终忽略多读出的Lane，也不能越过对象末尾加载数据。

### 4.7 SIMD程序的编译

在AArch64 Linux目标上，可以使用下面的本机编译命令：

```bash
g++ -std=c++17 -O3 -march=armv8-a simd_demo.cpp -o simd_demo
```

从x86 Linux交叉编译到AArch64时使用目标交叉编译器：

```bash
aarch64-linux-gnu-g++ \
  -std=c++17 -O3 -march=armv8-a \
  simd_demo.cpp -o simd_demo
```

`-march`规定生成代码允许使用的架构和扩展，`-mcpu`还可以针对具体处理器进行指令调度优化。`-mcpu=native`只适合在目标设备本机编译；交叉编译时，它检测到的是构建主机CPU，不能代表目标板。GCC当前支持的ARM目标参数以[GCC ARM Options](https://gcc.gnu.org/onlinedocs/gcc/ARM-Options.html)为准。

x86 AVX2使用`<immintrin.h>`和`-mavx2`。NEON与AVX2接口的基本对应关系如下：

| 操作 | ARM NEON | x86 AVX2 |
| --- | --- | --- |
| 加载浮点数 | `vld1q_f32` | `_mm256_loadu_ps` |
| 浮点乘法 | `vmulq_f32` | `_mm256_mul_ps` |
| 浮点加法 | `vaddq_f32` | `_mm256_add_ps` |
| 写回浮点数 | `vst1q_f32` | `_mm256_storeu_ps` |

两套Intrinsic的向量宽度、类型和函数名不同，不能直接互换。跨架构项目一般分别实现标量、NEON和AVX2函数，再在编译期或运行时选择当前CPU能够执行的版本。

## 5 SIMD数组并行Demo

### 5.1 Demo的完整执行顺序

SIMD Demo只做两个浮点数组的逐元素加法：

\[
\text{output}[i]=\text{left}[i]+\text{right}[i]
\]

程序按照下面的顺序运行：

```text
把当前线程绑定到CPU 0
        ↓
创建并填充两个输入数组
        ↓
运行NEON向量加法并计时
        ↓
打印NEON耗时和部分输出
```

这个文件只保留NEON实现。普通CPU标量版本放在另一个独立的`scalar_add.cpp`中，需要比较时分别编译运行两个程序。

### 5.2 设置当前线程的CPU亲和性

两个程序都会调用`pthread_setaffinity_np()`，把运行`main()`的当前线程限制到CPU 0。这样分别运行标量程序和SIMD程序时，两者都使用相同的CPU亲和性。

CPU 0只是示例值。如果目标设备的CPU拓扑或cpuset限制不同，应先使用`lscpu`和`pthread_getaffinity_np()`确认可用CPU，再修改`target_cpu`。

### 5.3 独立的NEON数组加法程序

NEON函数只使用三个核心接口：

```text
vld1q_f32()  加载4个float
vaddq_f32()  同时完成4组加法
vst1q_f32()  写回4个结果
```

数组长度特意设置为不能被4整除。完整的4元素数据块由NEON主循环处理，最后3个元素只能使用标量尾部循环收尾。这个尾部循环属于SIMD函数自身的边界处理，不承担普通CPU性能对比。

下面是只包含绑核和NEON计算的`simd_add.cpp`：

```cpp
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>

#include <arm_neon.h>

#include <chrono>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <vector>

// 把调用该函数的当前线程限制到一个逻辑CPU。
// cpu_index是Linux逻辑CPU编号；成功返回true，失败返回false。
bool bind_current_thread_to_cpu(int cpu_index)
{
    cpu_set_t cpu_set;
    CPU_ZERO(&cpu_set);              // 先清空集合，避免保留未初始化的CPU位。
    CPU_SET(cpu_index, &cpu_set);    // 只把目标CPU加入允许集合。

    // pthread_self()取得当前main线程的pthread_t。
    // 成功后，本线程后续的NEON计算只能被调度到cpu_index。
    const int error = pthread_setaffinity_np(
        pthread_self(), sizeof(cpu_set), &cpu_set);
    if (error != 0) {
        // Pthreads函数直接返回错误编号，所以把error交给strerror()。
        std::cerr << "set CPU affinity failed: "
                  << std::strerror(error) << '\n';
        return false;
    }

    // sched_getcpu()返回打印这一行时当前线程实际所在的逻辑CPU。
    std::cout << "current thread runs on CPU " << sched_getcpu() << '\n';
    return true;
}

// NEON函数每轮处理4个float，计算output[i] = left[i] + right[i]。
// left/right是只读输入，output由调用方分配，三个缓冲区都至少有count个元素。
// count允许不是4的整数倍，剩余元素会在函数末尾单独处理。
__attribute__((noinline))
void add_neon(const float* left,
              const float* right,
              float* output,
              std::size_t count)
{
    std::size_t index = 0;  // 下一批尚未处理的元素下标。

    // float32x4_t包含4个32位浮点Lane，所以每轮index增加4。
    for (; index + 4 <= count; index += 4) {
        // 分别从left[index]和right[index]开始连续加载4个float。
        const float32x4_t left_vector = vld1q_f32(left + index);
        const float32x4_t right_vector = vld1q_f32(right + index);

        // 四个Lane分别相加：L0+R0、L1+R1、L2+R2、L3+R3。
        const float32x4_t result_vector =
            vaddq_f32(left_vector, right_vector);

        // 从output[index]开始连续写回4个加法结果。
        vst1q_f32(output + index, result_vector);
    }

    // 示例数组最后剩3个元素，它们不足一个完整向量，由标量循环收尾。
    for (; index < count; ++index) {
        output[index] = left[index] + right[index];
    }
}

int main()
{
    constexpr int target_cpu = 0;  // 示例固定到CPU 0，可按目标板拓扑修改。

    // 先绑定当前线程；失败时停止测试，避免误以为计时发生在固定CPU上。
    if (!bind_current_thread_to_cpu(target_cpu)) {
        return 1;
    }

    // 65,539不能被4整除，最后3个元素用于展示尾部处理。
    constexpr std::size_t element_count = (1U << 16U) + 3U;
    constexpr int repetitions = 1000;  // 重复计算1000次，让计时时间足够明显。

    // 两个输入和一个输出分别拥有独立的连续内存。
    std::vector<float> left(element_count);
    std::vector<float> right(element_count);
    std::vector<float> neon_output(element_count);

    // 使用简单且确定的输入，保证每次运行都能复现相同结果。
    for (std::size_t index = 0; index < element_count; ++index) {
        left[index] = static_cast<float>(index % 100U);
        right[index] = static_cast<float>(index % 50U);
    }

    // 先运行一次进行预热，并提前生成一份有效输出。
    add_neon(left.data(), right.data(), neon_output.data(), element_count);

    // 在已经绑定到CPU 0的当前线程中重复执行NEON加法。
    const auto neon_begin = std::chrono::steady_clock::now();
    for (int repeat = 0; repeat < repetitions; ++repeat) {
        add_neon(left.data(), right.data(),
                 neon_output.data(), element_count);
    }
    const auto neon_end = std::chrono::steady_clock::now();

    // 把NEON计算的累计持续时间转换成毫秒。
    const double neon_ms =
        std::chrono::duration<double, std::milli>(
            neon_end - neon_begin).count();

    // 打印前两个元素和最后一个元素，能够同时观察主循环与尾部循环结果。
    std::cout << "output[0] = " << neon_output[0] << '\n';
    std::cout << "output[1] = " << neon_output[1] << '\n';
    std::cout << "output[last] = " << neon_output.back() << '\n';
    std::cout << "NEON total = " << neon_ms << " ms\n";
    return 0;
}
```

### 5.4 独立的普通CPU标量对比程序

只有需要测量普通标量循环时，才使用下面的`scalar_add.cpp`。它使用与`simd_add.cpp`相同的CPU编号、数组长度、输入内容和重复次数，但源码中不包含任何NEON类型和Intrinsic。

```cpp
#define _GNU_SOURCE
#include <pthread.h>
#include <sched.h>

#include <chrono>
#include <cstddef>
#include <cstring>
#include <iostream>
#include <vector>

// 把当前线程绑定到指定逻辑CPU，保证标量测试也固定在CPU 0上。
bool bind_current_thread_to_cpu(int cpu_index)
{
    cpu_set_t cpu_set;
    CPU_ZERO(&cpu_set);            // 清空允许集合。
    CPU_SET(cpu_index, &cpu_set);  // 只允许当前线程使用目标CPU。

    // pthread_self()表示当前main线程；失败时error直接保存错误编号。
    const int error = pthread_setaffinity_np(
        pthread_self(), sizeof(cpu_set), &cpu_set);
    if (error != 0) {
        std::cerr << "set CPU affinity failed: "
                  << std::strerror(error) << '\n';
        return false;
    }

    std::cout << "current thread runs on CPU " << sched_getcpu() << '\n';
    return true;
}

// 普通标量函数每轮只处理一个float。
// GCC属性关闭自动向量化，避免编译器把这个对比函数也改写为SIMD循环。
__attribute__((noinline, optimize("no-tree-vectorize")))
void add_scalar(const float* left,
                const float* right,
                float* output,
                std::size_t count)
{
    for (std::size_t index = 0; index < count; ++index) {
        output[index] = left[index] + right[index];
    }
}

int main()
{
    constexpr int target_cpu = 0;  // 与SIMD程序绑定到同一个逻辑CPU。
    constexpr std::size_t element_count = (1U << 16U) + 3U;  // 相同数组长度。
    constexpr int repetitions = 1000;  // 相同重复次数。

    if (!bind_current_thread_to_cpu(target_cpu)) {
        return 1;
    }

    // 两个输入和一个标量输出分别使用独立连续缓冲区。
    std::vector<float> left(element_count);
    std::vector<float> right(element_count);
    std::vector<float> scalar_output(element_count);

    // 输入生成规则必须与simd_add.cpp保持一致，才可以比较两次运行的耗时。
    for (std::size_t index = 0; index < element_count; ++index) {
        left[index] = static_cast<float>(index % 100U);
        right[index] = static_cast<float>(index % 50U);
    }

    // 预热一次，减少首次执行对正式计时的影响。
    add_scalar(left.data(), right.data(), scalar_output.data(), element_count);

    // 只计时1000次数组计算，不把绑核、分配和输入生成算入耗时。
    const auto scalar_begin = std::chrono::steady_clock::now();
    for (int repeat = 0; repeat < repetitions; ++repeat) {
        add_scalar(left.data(), right.data(),
                   scalar_output.data(), element_count);
    }
    const auto scalar_end = std::chrono::steady_clock::now();

    // 将累计持续时间转换为毫秒，供之后与NEON程序的输出相除。
    const double scalar_ms =
        std::chrono::duration<double, std::milli>(
            scalar_end - scalar_begin).count();

    std::cout << "output[0] = " << scalar_output[0] << '\n';
    std::cout << "output[1] = " << scalar_output[1] << '\n';
    std::cout << "output[last] = " << scalar_output.back() << '\n';
    std::cout << "scalar total = " << scalar_ms << " ms\n";
    return 0;
}
```

在同一台AArch64 Linux设备上分别编译运行：

```bash
g++ -std=c++17 -O3 -march=armv8-a -pthread \
  simd_add.cpp -o simd_add

g++ -std=c++17 -O3 -march=armv8-a -pthread \
  scalar_add.cpp -o scalar_add

./simd_add
./scalar_add
```

两个程序打印的三个示例输出应当相同。加速比可以使用`scalar total ÷ NEON total`计算。数组加法容易受到缓存和内存带宽限制，所以测得的比例不一定接近4。

## 6 使用SIMD将NV12转换为RGB Demo

### 6.1 NV12图像的数据排列

NV12是一种YUV 4:2:0双平面格式：

```text
Y平面：每个像素保存一个Y亮度值，尺寸为width × height

UV平面：U、V交错排列，尺寸为width × height/2
         U0 V0 U1 V1 U2 V2 ...
```

一个U、V色度样本由一个`2×2`像素块共享：

```text
Y00 Y01 ┐
Y10 Y11 ┘ 共同使用U0、V0
```

因此NV12要求宽度和高度为偶数。NV21的色度顺序是`V,U`，如果把NV21当成NV12读取，红色和蓝色会出现明显偏差。libyuv的[像素格式说明](https://chromium.googlesource.com/libyuv/libyuv/+/HEAD/docs/formats.md)也将NV12定义为完整Y平面加半宽、半高的交错UV色度平面。

### 6.2 YUV转RGB的计算公式

本Demo固定使用BT.601有限范围，并使用常见的8位整数近似公式：

\[
C=\max(0,Y-16),\qquad D=U-128,\qquad E=V-128
\]

\[
R=\operatorname{clip}_{0}^{255}
\left(\frac{298C+409E+128}{256}\right)
\]

\[
G=\operatorname{clip}_{0}^{255}
\left(\frac{298C-100D-208E+128}{256}\right)
\]

\[
B=\operatorname{clip}_{0}^{255}
\left(\frac{298C+516D+128}{256}\right)
\]

其中，`Y`、`U`、`V`是输入字节，`R`、`G`、`B`是输出字节。`clip`把结果限制在`0～255`。右移8位实现除以256，加入128用于整数定点计算中的舍入。

颜色矩阵和范围必须与视频源一致。BT.709、BT.2020或全范围数据需要使用不同系数；单纯提高SIMD计算速度无法修复颜色标准选择错误。

### 6.3 NEON加载和拆分NV12数据

NEON版本每轮处理16个Y像素。对应的UV区域包含8组`U,V`，共16字节：

```text
16个Y：Y0 Y1 Y2 Y3 ... Y14 Y15
8组UV：U0 V0 U1 V1 ... U7 V7
```

`vld2_u8()`读取16个交错字节，并自动拆成8个U和8个V。`vzip_u8(u, u)`再把每个U复制两次：

```text
U0 U0 U1 U1 U2 U2 ... U7 U7
```

V执行同样操作后，16个Y就分别拥有与自己对应的U、V值。

### 6.4 NEON并行计算RGB

每8个像素的计算先把`uint8`扩展为`int16`，完成偏置处理后，再拆成两组4 Lane并扩展为`int32`。使用32位中间值，是为了容纳`516 × 127`这类乘法结果，避免计算过程中溢出。

公式计算结束后，`vqmovn_s32()`把32位结果饱和收窄为16位；`vqmovun_s16()`再将负数限制为0、将超过255的数限制为255，并生成最终的8位RGB数据。

### 6.5 RGB交错写回

`vst3q_u8()`接收R、G、B三个16 Lane向量，并按RGB交错顺序一次写出48字节：

```text
R0 G0 B0 R1 G1 B1 ... R15 G15 B15
```

为了让代码只保留完整的NEON处理路径，本Demo要求图像宽度能够被16整除。示例使用`640×480`，所以每一行都能由NEON循环完整处理，不需要额外的行尾处理代码。

### 6.6 纯NEON NV12转RGB Demo

下面的`nv12_to_rgb_neon.cpp`只保留一条清晰的NEON转换流程：

1. 准备一帧`640×480`的NV12测试图像。
2. 每轮读取16个Y和8组UV。
3. 使用NEON并行计算16个RGB像素。
4. 使用`vst3q_u8()`交错写回RGB。
5. 将结果保存为`nv12_neon.ppm`。

```cpp
#include <arm_neon.h>

#include <chrono>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

// 保存8个像素已经计算完成的R、G、B通道。
// 三个向量中相同的Lane编号始终对应同一个像素。
struct Rgb8 {
    uint8x8_t red;    // 8个像素的R通道，范围已经限制为0～255。
    uint8x8_t green;  // 8个像素的G通道，范围已经限制为0～255。
    uint8x8_t blue;   // 8个像素的B通道，范围已经限制为0～255。
};

// 保存4个像素的32位计算结果。
// 此时尚未限制到0～255，后面还需要执行饱和收窄。
struct Rgb32x4 {
    int32x4_t red;
    int32x4_t green;
    int32x4_t blue;
};

// 使用BT.601有限范围整数公式，同时计算4个像素。
//
// c16：4个已经完成max(0, Y - 16)的亮度值。
// d16：4个已经完成U - 128的色度值。
// e16：4个已经完成V - 128的色度值。
// 返回值：4个像素的32位R、G、B中间结果。
Rgb32x4 calculate_rgb_4(int16x4_t c16,
                        int16x4_t d16,
                        int16x4_t e16)
{
    // 将4个16位Lane符号扩展为4个32位Lane，避免乘法溢出。
    const int32x4_t c = vmovl_s16(c16);
    const int32x4_t d = vmovl_s16(d16);
    const int32x4_t e = vmovl_s16(e16);

    // 每个Lane都加入128，后续右移8位时完成定点舍入。
    const int32x4_t rounding = vdupq_n_s32(128);

    // R = (298 * C + 409 * E + 128) >> 8。
    int32x4_t red = vmulq_n_s32(c, 298);
    red = vmlaq_n_s32(red, e, 409);
    red = vshrq_n_s32(vaddq_s32(red, rounding), 8);

    // G = (298 * C - 100 * D - 208 * E + 128) >> 8。
    int32x4_t green = vmulq_n_s32(c, 298);
    green = vmlaq_n_s32(green, d, -100);
    green = vmlaq_n_s32(green, e, -208);
    green = vshrq_n_s32(vaddq_s32(green, rounding), 8);

    // B = (298 * C + 516 * D + 128) >> 8。
    int32x4_t blue = vmulq_n_s32(c, 298);
    blue = vmlaq_n_s32(blue, d, 516);
    blue = vshrq_n_s32(vaddq_s32(blue, rounding), 8);

    return {red, green, blue};
}

// 同时转换8个像素。
//
// y8：8个连续像素的Y值。
// u8/v8：已经按像素复制完成的U、V值，同一Lane对应同一个Y像素。
// 返回值：8个已经限制到0～255的R、G、B值。
Rgb8 convert_8_pixels(uint8x8_t y8,
                      uint8x8_t u8,
                      uint8x8_t v8)
{
    // 先把8位无符号输入扩展为16位，给减法留下有符号数空间。
    int16x8_t c16 = vreinterpretq_s16_u16(vmovl_u8(y8));
    int16x8_t d16 = vreinterpretq_s16_u16(vmovl_u8(u8));
    int16x8_t e16 = vreinterpretq_s16_u16(vmovl_u8(v8));

    // BT.601有限范围中的Y需要减16，低于16的结果限制为0。
    c16 = vsubq_s16(c16, vdupq_n_s16(16));
    c16 = vmaxq_s16(c16, vdupq_n_s16(0));

    // U、V以128为中性值，减去128后得到有正有负的色度偏移。
    d16 = vsubq_s16(d16, vdupq_n_s16(128));
    e16 = vsubq_s16(e16, vdupq_n_s16(128));

    // int32x4_t一次容纳4个Lane，所以分别计算前4个和后4个像素。
    const Rgb32x4 low = calculate_rgb_4(
        vget_low_s16(c16),
        vget_low_s16(d16),
        vget_low_s16(e16));

    const Rgb32x4 high = calculate_rgb_4(
        vget_high_s16(c16),
        vget_high_s16(d16),
        vget_high_s16(e16));

    // 先将两组int32结果饱和收窄并合并成8个int16 Lane。
    const int16x8_t red16 = vcombine_s16(
        vqmovn_s32(low.red), vqmovn_s32(high.red));
    const int16x8_t green16 = vcombine_s16(
        vqmovn_s32(low.green), vqmovn_s32(high.green));
    const int16x8_t blue16 = vcombine_s16(
        vqmovn_s32(low.blue), vqmovn_s32(high.blue));

    // 再收窄为uint8：负数变成0，超过255的数变成255。
    return {
        vqmovun_s16(red16),
        vqmovun_s16(green16),
        vqmovun_s16(blue16),
    };
}

// 使用NEON将一帧紧凑排列的NV12图像转换为紧凑排列的RGB图像。
//
// y_plane：Y平面首地址，大小必须至少为width * height字节。
// uv_plane：UV平面首地址，大小必须至少为width * height / 2字节。
// width/height：图像尺寸；width必须被16整除，height必须是偶数。
// rgb：输出缓冲区首地址，大小必须至少为width * height * 3字节。
void nv12_to_rgb_neon(const uint8_t* y_plane,
                      const uint8_t* uv_plane,
                      int width,
                      int height,
                      uint8_t* rgb)
{
    // 本Demo每次固定处理16个像素，因此拒绝不满足完整向量宽度的输入。
    if ((width % 16) != 0 || (height % 2) != 0) {
        throw std::invalid_argument(
            "width must be divisible by 16 and height must be even");
    }

    for (int row = 0; row < height; ++row) {
        // Y每行有width字节。
        const uint8_t* y_row = y_plane + row * width;

        // NV12的UV高度是Y的一半，所以相邻两行共享同一行UV。
        const uint8_t* uv_row = uv_plane + (row / 2) * width;

        // RGB每个像素占3字节。
        uint8_t* rgb_row = rgb + row * width * 3;

        // 每轮完整转换16个像素，示例宽度640可以完整执行40轮。
        for (int column = 0; column < width; column += 16) {
            // 读取Y0～Y15，共16个连续亮度字节。
            const uint8x16_t y16 = vld1q_u8(y_row + column);

            // 读取U0,V0...U7,V7，并自动拆成8个U和8个V。
            const uint8x8x2_t uv = vld2_u8(uv_row + column);

            // 一个色度样本由横向相邻的两个像素共享。
            // zip(u,u)把U0～U7分别复制两次，V也执行相同操作。
            const uint8x8x2_t duplicated_u =
                vzip_u8(uv.val[0], uv.val[0]);
            const uint8x8x2_t duplicated_v =
                vzip_u8(uv.val[1], uv.val[1]);

            // 先转换本批次的前8个像素。
            const Rgb8 low = convert_8_pixels(
                vget_low_u8(y16),
                duplicated_u.val[0],
                duplicated_v.val[0]);

            // 再转换本批次的后8个像素。
            const Rgb8 high = convert_8_pixels(
                vget_high_u8(y16),
                duplicated_u.val[1],
                duplicated_v.val[1]);

            // 合并前后两组结果，得到16个R、16个G和16个B。
            uint8x16x3_t rgb16;
            rgb16.val[0] = vcombine_u8(low.red, high.red);
            rgb16.val[1] = vcombine_u8(low.green, high.green);
            rgb16.val[2] = vcombine_u8(low.blue, high.blue);

            // 从当前像素的RGB位置开始，一次交错写出16组RGB，共48字节。
            vst3q_u8(rgb_row + column * 3, rgb16);
        }
    }
}

// 生成一帧可直接用于本Demo的NV12测试数据。
//
// nv12：调用方分配的width * height * 3 / 2字节连续缓冲区。
// width/height：偶数图像尺寸，本函数按无额外行填充的紧凑布局写入。
void make_test_nv12(std::vector<uint8_t>& nv12,
                    int width,
                    int height)
{
    // Y平面位于缓冲区开头。
    uint8_t* y_plane = nv12.data();

    // UV平面紧跟在width * height字节的Y平面之后。
    uint8_t* uv_plane = y_plane + width * height;

    // 让Y从左向右由16渐变到235，便于观察亮度变化。
    for (int row = 0; row < height; ++row) {
        for (int column = 0; column < width; ++column) {
            y_plane[row * width + column] = static_cast<uint8_t>(
                16 + (219 * column) / (width - 1));
        }
    }

    // UV平面只有height / 2行，每次写入一组交错的U、V。
    for (int row = 0; row < height / 2; ++row) {
        for (int column = 0; column < width; column += 2) {
            // 固定的U、V会生成带颜色的亮度渐变图，方便确认结果可见。
            uv_plane[row * width + column] = 90;       // U分量。
            uv_plane[row * width + column + 1] = 240; // V分量。
        }
    }
}

// 将紧凑排列的RGB数据保存成不依赖OpenCV的P6格式PPM文件。
bool write_ppm(const std::string& path,
               const std::vector<uint8_t>& rgb,
               int width,
               int height)
{
    // binary确保像素字节不会受到文本模式转换影响。
    std::ofstream file(path, std::ios::binary);
    if (!file) {
        return false;
    }

    // P6表示二进制RGB，255表示每个颜色通道的最大值。
    file << "P6\n" << width << ' ' << height << "\n255\n";

    // RGB缓冲区已经按RGBRGB顺序排列，可以一次写出全部像素。
    file.write(
        reinterpret_cast<const char*>(rgb.data()),
        static_cast<std::streamsize>(rgb.size()));

    return static_cast<bool>(file);
}

int main()
{
    constexpr int width = 640;   // 640可以被16整除，每行完整执行NEON循环。
    constexpr int height = 480;  // NV12 4:2:0要求高度为偶数。

    // NV12由一份Y和半份UV组成，总大小为width * height * 3 / 2字节。
    std::vector<uint8_t> nv12(width * height * 3 / 2);

    // RGB每个像素占3字节。
    std::vector<uint8_t> rgb(width * height * 3);

    // 准备测试输入；实际项目中可换成摄像头或解码器提供的NV12内存。
    make_test_nv12(nv12, width, height);

    // 紧凑NV12中，UV平面紧跟在完整的Y平面之后。
    const uint8_t* y_plane = nv12.data();
    const uint8_t* uv_plane = y_plane + width * height;

    // 只执行NEON转换，并记录本次完整帧转换耗时。
    const auto begin = std::chrono::steady_clock::now();
    nv12_to_rgb_neon(
        y_plane,
        uv_plane,
        width,
        height,
        rgb.data());
    const auto end = std::chrono::steady_clock::now();

    // 保存结果，便于直接检查转换后的图像。
    if (!write_ppm("nv12_neon.ppm", rgb, width, height)) {
        std::cerr << "failed to write nv12_neon.ppm\n";
        return 1;
    }

    const double elapsed_ms =
        std::chrono::duration<double, std::milli>(end - begin).count();

    std::cout << "NEON conversion: " << elapsed_ms << " ms\n";
    std::cout << "output: nv12_neon.ppm\n";
    return 0;
}
```

在AArch64 Linux设备上编译：

```bash
g++ -std=c++17 -O3 -march=armv8-a \
  nv12_to_rgb_neon.cpp -o nv12_to_rgb_neon
./nv12_to_rgb_neon
```

程序只会执行NEON转换，并生成`nv12_neon.ppm`。这个文件可以用支持PPM格式的图像查看器打开。
