---
title: '[嵌入式AI-推理部署] RKNN板端使用'
published: 2026-09-24T08:36:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍RKNN板端使用的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-9 RKNN板端使用

阶段4-7已经介绍了怎样把ONNX转换成面向RK3588的RKNN模型。本阶段继续解决下一步问题：已经拿到`.rknn`文件以后，怎样把它放到RK3588板端，并通过C++程序完成一次可靠的NPU推理。

本文只讨论模型入口到模型出口这一段：

```text
.rknn模型
→ 创建RKNN上下文
→ 查询模型输入输出
→ 提交输入Tensor
→ NPU执行
→ 取得输出Tensor
→ 释放资源
```

图片解码、YOLO检测头解码、非极大值抑制和检测框绘制不属于RKNN Runtime本身，因此不会塞进本阶段的封装。这样可以先把板端Runtime主线学清楚，再把它接入自己的图像处理和后处理工程。

## 1 从RKNN模型到板端程序还缺少什么

### 1.1 `.rknn`模型不能自己执行

`.rknn`文件保存的是经过RKNN Toolkit2转换和编译后的部署模型。它包含处理后的计算图、权重、量化参数以及面向目标NPU的模型描述，但它不是一个可以直接运行的Linux程序。

要在RK3588上执行这个模型，还需要四部分：

| 内容 | 作用 |
| --- | --- |
| `.rknn`模型 | 描述NPU需要执行的网络 |
| `rknn_api.h` | 向C/C++程序声明RKNN Runtime接口和结构体 |
| `librknnrt.so` | 实现`rknn_init()`、`rknn_run()`等接口 |
| RKNPU驱动 | 让RKNN Runtime向RK3588的NPU提交任务 |

应用程序负责把它们连接起来：读取模型、建立上下文、准备输入、发起推理、读取输出并释放资源。

```text
C++应用
  ├─包含rknn_api.h
  ├─链接librknnrt.so
  ├─加载yolo11n.rknn
  └─调用RKNN Runtime API
          ↓
      RKNPU驱动
          ↓
      RK3588 NPU
```

### 1.2 编译时依赖和运行时依赖不是一回事

编译程序时，编译器需要找到：

- `rknn_api.h`，否则不知道函数和结构体的声明；
- `librknnrt.so`，否则链接阶段找不到RKNN函数的实现。

程序放到板端执行时，Linux动态加载器还要再次找到`librknnrt.so`。因此，“已经成功编译”不代表“板端一定能够运行”。

如果运行时出现下面的错误：

```text
error while loading shared libraries: librknnrt.so:
cannot open shared object file: No such file or directory
```

它不是模型错误，而是动态加载器没有找到Runtime库。可以临时指定库目录：

```bash
# $PWD/lib表示当前工程目录下的lib目录。
# 这里只影响当前终端会话，关闭终端后不会永久写入系统配置。
export LD_LIBRARY_PATH="$PWD/lib:$LD_LIBRARY_PATH"

./rknn_minimal_demo model/yolo11n.rknn input_640x640_rgb.bin
```

也可以把库安装到板端系统库目录并更新动态库缓存，但学习阶段让动态库跟随程序部署更容易核对版本。

### 1.3 版本和CPU架构需要配套

需要同时注意两类匹配关系。

第一类是CPU架构。RK3588 Linux用户态通常是AArch64，因此应使用AArch64版本的`librknnrt.so`。x86_64开发主机上的Runtime库不能直接复制到RK3588运行。

第二类是软件版本。以下组件应尽量来自同一套或官方声明兼容的发布版本：

- 生成模型的RKNN Toolkit2；
- 板端`librknnrt.so`；
- 板端RKNPU驱动；
- 编译时使用的`rknn_api.h`。

如果`rknn_init()`返回设备或模型版本不匹配一类错误，不能只反复重新转换模型，还要一起检查Runtime和驱动版本。

## 2 建立最小RKNN板端C++工程

### 2.1 工程目录

本阶段不复制官方YOLO11 Demo，而是自己建立一个只依赖RKNN Runtime的最小工程：

```text
rknn_minimal_demo/
├── CMakeLists.txt
├── include/
│   ├── rknn_api.h
│   └── simple_rknn_model.hpp
├── lib/
│   └── librknnrt.so
├── model/
│   └── yolo11n.rknn
├── src/
│   ├── simple_rknn_model.cpp
│   └── main.cpp
└── input_640x640_rgb.bin
```

这里的`rknn_api.h`和`librknnrt.so`应从当前使用的RKNPU2 SDK或RKNN Toolkit2配套目录中取得。官方仓库中也提供了不同平台的Runtime目录，可用来核对目标平台的头文件和库：[RKNPU2官方仓库](https://github.com/airockchip/rknn-toolkit2/tree/master/rknpu2)。

### 2.2 CMake怎样找到头文件和动态库

```cmake
cmake_minimum_required(VERSION 3.16)
project(rknn_minimal_demo LANGUAGES CXX)

# 使用C++17，方便使用std::vector、异常和文件流组织资源。
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(rknn_minimal_demo
    src/main.cpp
    src/simple_rknn_model.cpp
)

# 让源文件能够通过#include "rknn_api.h"和
# #include "simple_rknn_model.hpp"找到头文件。
target_include_directories(rknn_minimal_demo PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

# 直接写出动态库的完整路径，避免学习阶段混淆系统中其他版本的librknnrt.so。
target_link_libraries(rknn_minimal_demo PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/lib/librknnrt.so
)
```

如果直接在RK3588板端编译：

```bash
cmake -S . -B build
cmake --build build -j4
```

如果在x86_64电脑上交叉编译，则还需要AArch64交叉编译器和相应的CMake工具链文件。无论在哪里编译，最后都要确认生成程序的目标架构：

```bash
file build/rknn_minimal_demo
file lib/librknnrt.so
```

两者在RK3588上通常都应该显示AArch64，而不是x86-64。

## 3 先认识RK3588的NPU

### 3.1 NPU核心与CPU线程不是一回事

RK3588的NPU由三个核心组成，在RKNN接口中编号为`CORE_0`、`CORE_1`和`CORE_2`。这些是执行神经网络计算的NPU核心，不是Linux看到的CPU核心，也不是C++的`std::thread`。

三个概念需要分开：

| 概念 | 控制什么 |
| --- | --- |
| C++线程 | 应用程序中哪些任务并发执行 |
| `rknn_context` | 一个模型在RKNN Runtime中的运行实例 |
| NPU core mask | 某个上下文可以使用哪些NPU核心 |

例如，一个CPU线程可以持有一个RKNN上下文，并让它只运行在NPU核心0；也可以创建三个CPU推理线程，让三个独立上下文分别使用三个NPU核心。

### 3.2 怎样查看NPU频率

RK3588常见Linux BSP会把NPU的devfreq节点放在：

```bash
# 查看当前频率，常见单位为Hz。
cat /sys/class/devfreq/fdab0000.npu/cur_freq

# 查看当前系统允许使用的NPU频率档位。
cat /sys/class/devfreq/fdab0000.npu/available_frequencies

# 查看当前调频策略，例如userspace、performance或其他策略。
cat /sys/class/devfreq/fdab0000.npu/governor
```

不同开发板厂商、内核版本和设备树可能产生不同路径。如果上面的目录不存在，可以先查找实际NPU devfreq目录：

```bash
find /sys/class/devfreq -maxdepth 2 \
    \( -name cur_freq -o -name available_frequencies -o -name governor \) \
    -print
```

Rockchip官方用于RK3588的定频脚本同样通过`/sys/class/devfreq/fdab0000.npu/`读取和设置NPU频率。正式测试性能时要记录调频策略，否则同一模型多次测试可能因频率变化得到不同结果。[RK3588官方定频脚本](https://github.com/airockchip/rknn-llm/blob/main/scripts/fix_freq_rk3588.sh)

学习阶段先查看，不要急着长期锁定最高频率。锁频会改变功耗和温度，持续高温还可能触发系统降频。

### 3.3 怎样查看三个NPU核心的占用率

常见RKNPU驱动会在debugfs中提供负载信息：

```bash
# 每0.5秒刷新一次，方便观察推理期间三个核心的变化。
watch -n 0.5 'cat /sys/kernel/debug/rknpu/load'
```

RK3588上常见输出类似：

```text
NPU load: Core0: 72%, Core1: 0%, Core2: 0%
```

它表示采样窗口内三个NPU核心的繁忙比例，不等于模型精度、FPS或单次推理时间。短模型执行时间很短时，刷新间隔也会影响看到的数值。

如果`/sys/kernel/debug/rknpu/load`不存在，先检查debugfs和RKNPU驱动：

```bash
# 查看debugfs是否已经挂载。
mount | grep debugfs

# 查看内核是否识别RKNPU设备和驱动版本。
dmesg | grep -i rknpu
```

是否提供`load`节点取决于板端内核和RKNPU驱动，不能把某个厂商镜像的路径当成所有系统都必然存在的标准接口。

### 3.4 单上下文多核与多上下文并发

RKNN提供`rknn_set_core_mask()`选择上下文使用的NPU核心：[RKNN C API头文件](https://github.com/airockchip/rknn_model_zoo/blob/main/3rdparty/rknpu2/include/rknn_api.h)。

```cpp
// 只让当前上下文使用NPU核心0。
rknn_set_core_mask(ctx, RKNN_NPU_CORE_0);

// 允许当前上下文组合使用三个NPU核心。
rknn_set_core_mask(ctx, RKNN_NPU_CORE_0_1_2);
```

这两种常见目标不同：

```text
降低单帧延迟：
一个上下文 → 组合使用多个NPU核心 → 处理一帧

提高多帧吞吐：
线程0 / 上下文0 → NPU核心0 → 帧0、帧3、帧6
线程1 / 上下文1 → NPU核心1 → 帧1、帧4、帧7
线程2 / 上下文2 → NPU核心2 → 帧2、帧5、帧8
```

把一个上下文设为`RKNN_NPU_CORE_0_1_2`，不等于创建了三个C++线程，也不保证单帧速度一定变成三倍。模型拆分、跨核同步和内存带宽都会影响收益。

多线程推理时，稳妥做法是每个推理线程持有独立上下文和独立输入输出缓冲区。不要让多个线程无保护地同时操作同一个`rknn_context`，否则输入、输出和资源生命周期容易混在一起。

## 4 RKNN初始化：得到上下文、接口信息和所需内存

### 4.1 初始化阶段先做哪些事情

对于固定输入shape的YOLO11，初始化阶段可以整理成：

```text
读取.rknn模型
→ rknn_init()创建上下文
→ rknn_set_core_mask()选择NPU核心
→ rknn_query()查询输入输出数量与属性
→ 保存每个输入输出的index、name、shape、dtype和layout
→ 根据需要准备普通指针内存或rknn_tensor_mem
```

这部分通常在程序启动时执行一次。每一帧推理不需要重新读取模型，也不需要重复查询固定不变的输入输出属性。

### 4.2 读取模型、创建上下文并选择NPU核心

先把`.rknn`文件读入应用内存，再创建`rknn_context`：

```cpp
std::vector<uint8_t> model_data = read_binary_file("yolo11n.rknn");

rknn_context ctx = 0;

int ret = rknn_init(
    &ctx,
    model_data.data(),
    static_cast<uint32_t>(model_data.size()),
    0,
    nullptr
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "rknn_init失败，返回值=" + std::to_string(ret)
    );
}
```

上下文创建成功后，可以选择当前模型使用的NPU核心：

```cpp
// 第一次跑通可以使用AUTO。
// 测试单核或组合多核时，再换成对应的core mask。
ret = rknn_set_core_mask(
    ctx,
    RKNN_NPU_CORE_AUTO
);

if (ret != RKNN_SUCC) {
    rknn_destroy(ctx);
    throw std::runtime_error(
        "rknn_set_core_mask失败，返回值=" +
        std::to_string(ret)
    );
}
```

`rknn_set_core_mask()`控制当前上下文在哪些NPU核心上计算，与输入输出内存来自普通指针还是DMA-BUF没有直接关系。

### 4.3 查询模型输入输出

#### 4.3.1 静态shape模型在初始化阶段查询一次

对于固定`640×640`输入的YOLO11，输入输出接口不会在每帧之间变化，因此应该在初始化阶段完成查询并保存结果。

先查询SDK、驱动和输入输出数量：

```cpp
rknn_sdk_version sdk_version{};

int ret = rknn_query(
    ctx,
    RKNN_QUERY_SDK_VERSION,
    &sdk_version,
    sizeof(sdk_version)
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error("查询SDK版本失败");
}

rknn_input_output_num io_num{};

ret = rknn_query(
    ctx,
    RKNN_QUERY_IN_OUT_NUM,
    &io_num,
    sizeof(io_num)
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error("查询输入输出数量失败");
}
```

再分别查询所有输入和输出：

```cpp
std::vector<rknn_tensor_attr> input_attrs(io_num.n_input);
std::vector<rknn_tensor_attr> output_attrs(io_num.n_output);

for (uint32_t i = 0; i < io_num.n_input; ++i) {
    input_attrs[i] = {};

    // index表示要查询模型的第几个输入入口。
    input_attrs[i].index = i;

    ret = rknn_query(
        ctx,
        RKNN_QUERY_INPUT_ATTR,
        &input_attrs[i],
        sizeof(rknn_tensor_attr)
    );

    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "查询输入失败，index=" + std::to_string(i)
        );
    }
}

for (uint32_t i = 0; i < io_num.n_output; ++i) {
    output_attrs[i] = {};

    // 输出也有自己的index 0、1、2……
    output_attrs[i].index = i;

    ret = rknn_query(
        ctx,
        RKNN_QUERY_OUTPUT_ATTR,
        &output_attrs[i],
        sizeof(rknn_tensor_attr)
    );

    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "查询输出失败，index=" + std::to_string(i)
        );
    }
}
```

这里得到的`input_attrs`和`output_attrs`可以看成模型初始化后的“基础属性结构体”。静态shape模型后续直接使用它们；动态shape模型会复制基础输入属性、修改`dims`，调用`rknn_set_input_shapes()`设置当前shape，然后通过`RKNN_QUERY_CURRENT_INPUT_ATTR`和`RKNN_QUERY_CURRENT_OUTPUT_ATTR`再次查询当前属性。

查询后要保存：

- `index`与`name`：确定第几个输入或输出对应模型的什么入口；
- `dims`与`fmt`：确定shape以及NCHW、NHWC等排列方式；
- `type`：确定UINT8、INT8、FLOAT32等数据类型；
- `qnt_type`、`zp`和`scale`：解释量化输入输出；
- `size`：普通Tensor字节数；
- `size_with_stride`和`w_stride`：NPU对齐后的内存要求。

输入和输出分别位于两张接口表中，所以可能同时存在：

```text
input index 0  → images
output index 0 → output0
```

不能因为二者都是`index=0`就把它们当成同一个Tensor。`RKNN_QUERY_INPUT_ATTR`取得的是输入描述，`RKNN_QUERY_OUTPUT_ATTR`取得的是输出描述。后面绑定内存时，应继续使用查询得到的对应属性，而不是自己只填写一个index重新构造。

#### 4.3.2 动态shape为什么可能在推理阶段重新查询

动态shape模型与静态YOLO11不同。输入shape可能在不同任务之间变化，例如：

```text
第1次推理：1×3×640×640
第2次推理：1×3×960×960
```

这种情况下，初始化时仍会查询模型的输入输出数量、支持范围或最大内存要求；当应用切换到新的shape后，还可能需要查询当前输入输出属性，再决定本次shape需要的有效大小和解释方式。

因此可以概括为：

```text
静态shape：
初始化时查询一次
→ 每帧直接推理

动态shape：
初始化时查询模型基础接口和范围
→ shape发生变化时设置新shape
→ 必要时查询当前输入输出属性
→ 调整或重新准备内存
→ 再执行推理
```

动态模型不是“每一帧必然查询”，而是当shape或接口状态变化时才需要重新确认。本文后续Demo使用静态YOLO11，所以不会在推理循环中重复查询。

### 4.4 创建输入输出所需的内存

#### 4.4.1 输入输出内存先分成两种形式

从应用程序看到的形式来说，模型输入输出主要有两类内存。

第一类是普通指针形式：

```text
std::vector.data()
malloc()返回的地址
连续cv::Mat.data
应用自己的数组或连续Tensor地址
```

它们最终表现为一个`void*`和对应字节数。使用这种方式时，不需要调用RKNN的Tensor内存创建函数，内存仍由应用或相应库管理。

例如：

```cpp
std::vector<uint8_t> rgb_tensor(640 * 640 * 3);

// rgb_tensor.data()是普通CPU指针。
// 这一步只是创建应用内存，还没有把它交给模型。
void* input_pointer = rgb_tensor.data();
std::size_t input_bytes = rgb_tensor.size();
```

第二类是`rknn_tensor_mem`形式：

```text
rknn_tensor_mem
├─ virt_addr
├─ phys_addr
├─ fd
├─ size
└─ 其他Runtime内存信息
```

这种形式用于RKNN能够直接识别和管理的Tensor内存。第4.4节所说的“创建内存”，主要针对这一类。

需要先记住：创建出`rknn_tensor_mem`只表示得到了一块候选Tensor内存，还没有说明它最终属于哪个输入或输出。它的具体用途会在第5部分推理流程中确定。

#### 4.4.2 方式一：由RKNN Runtime创建

最直接的方式是调用`rknn_create_mem()`：

```cpp
// 当前Tensor包含stride对齐后真正需要的整体空间。
const uint32_t input_mem_size =
    input_attr.size_with_stride != 0
        ? input_attr.size_with_stride
        : input_attr.size;

rknn_tensor_mem* input_mem =
    rknn_create_mem(ctx, input_mem_size);

if (input_mem == nullptr) {
    throw std::runtime_error("rknn_create_mem失败");
}
```

`rknn_create_mem()`主要接收：

- 当前`rknn_context`；
- 需要申请的字节数。

返回的`rknn_tensor_mem`通常提供CPU可访问的`virt_addr`以及Runtime需要的内存信息。CPU可以通过`virt_addr`写入输入或读取输出。

例如，OpenCV可以把这块地址包装成一个不拥有底层内存的`cv::Mat`：

```cpp
// row_step必须根据真实width、channel和w_stride计算。
// 这里假设已经从input_attr得到正确的行跨度。
cv::Mat rknn_tensor_image(
    input_height,
    input_width,
    CV_8UC3,
    input_mem->virt_addr,
    row_step
);
```

这并不代表图片解码、resize或颜色转换不再耗时，只是让最终结果可以直接写入RKNN创建的Tensor内存，减少再复制到另一块输入内存的机会。

#### 4.4.3 方式二：从外部内存导入

摄像头、DRM、RGA或其他模块可能已经拥有DMA-BUF。此时不必再申请另一块同样大小的RKNN内存，可以把外部内存导入为`rknn_tensor_mem`：

```cpp
// 不能直接把任意DMA-BUF大小交给RKNN。
// 先根据对应Tensor属性取得带stride后的整体空间要求。
const uint32_t required_size =
    tensor_attr.size_with_stride != 0
        ? tensor_attr.size_with_stride
        : tensor_attr.size;

// offset表示Tensor区域在DMA-BUF中的起始偏移。
// 外部buffer必须真正容纳offset之后的整个Tensor区域。
if (offset + required_size > buffer_size) {
    throw std::runtime_error(
        "DMA-BUF容量不足，无法容纳当前Tensor"
    );
}

rknn_tensor_mem* imported_mem =
    rknn_create_mem_from_fd(
        ctx,
        dma_fd,
        virtual_address,
        required_size,
        offset
    );

if (imported_mem == nullptr) {
    throw std::runtime_error(
        "rknn_create_mem_from_fd失败"
    );
}
```

这个函数的作用是把外部FD及其地址、大小、偏移信息包装成当前上下文能够识别的`rknn_tensor_mem`。它不负责图片预处理，也不代表这块内存已经成为某个模型输入或输出。

这里传入的`required_size`描述从`offset`开始交给RKNN使用的Tensor区域大小；底层DMA-BUF的实际总容量可以更大，但不能小于`offset + required_size`。

某些平台还提供从物理地址或其他系统内存对象创建`rknn_tensor_mem`的接口，具体使用哪一种取决于板端内存来源和当前SDK支持范围。

#### 4.4.4 DMA-BUF缓冲池应在初始化阶段导入

摄像头通常使用多个DMA-BUF循环采集：

```text
第0帧 → dma_fd0
第1帧 → dma_fd1
第2帧 → dma_fd2
第3帧 → 再回到dma_fd0
```

建议在初始化阶段把缓冲池中每个FD分别导入一次：

```cpp
constexpr int kBufferCount = 3;
rknn_tensor_mem* imported_mems[kBufferCount]{};

// 缓冲池中的每一块内存都要满足同一个当前输入Tensor的
// size_with_stride要求。
const uint32_t required_input_size =
    input_attr.size_with_stride != 0
        ? input_attr.size_with_stride
        : input_attr.size;

for (int i = 0; i < kBufferCount; ++i) {
    if (buffer_sizes[i] < required_input_size) {
        throw std::runtime_error(
            "DMA-BUF容量不足，index=" +
            std::to_string(i)
        );
    }

    imported_mems[i] = rknn_create_mem_from_fd(
        ctx,
        dma_fds[i],
        virtual_addresses[i],
        required_input_size,
        0
    );

    if (imported_mems[i] == nullptr) {
        throw std::runtime_error(
            "导入DMA-BUF失败，index=" +
            std::to_string(i)
        );
    }
}
```

每个FD只导入一次，后续按照帧所在的buffer编号选择对应`rknn_tensor_mem`。这里创建的是候选内存池，怎样选择当前输入放到第5部分解释。

前提是这些buffer最终保存的数据符合模型输入要求。如果摄像头给出的是原始YUV，而模型需要`640×640 RGB UINT8 NHWC`，通常还要由RGA写入另一组满足模型输入要求的DMA-BUF池。

#### 4.4.5 `size_with_stride`才是带对齐后的整体空间要求

每一个输入或输出的`rknn_tensor_attr`中都有与内存大小相关的字段：

```cpp
uint32_t size;
uint32_t w_stride;
uint32_t size_with_stride;
```

其中：

- `size`是Tensor有效元素按照当前dtype计算得到的普通字节数；
- `w_stride`是宽度方向经过硬件对齐后的行跨度信息；
- `size_with_stride`是把stride和硬件对齐空间计算进去以后，这个Tensor整体需要覆盖的内存空间。

因此，创建或导入输入输出内存时，不能只使用`attr.size`，也不能只按照`width × height × channel`自行估算。应先计算：

```cpp
const uint32_t required_size =
    attr.size_with_stride != 0
        ? attr.size_with_stride
        : attr.size;
```

某些接口或Tensor没有额外stride时，`size_with_stride`可能为0，此时才退回使用`size`。只要`size_with_stride`有效，它就是当前Tensor带对齐后的整体空间要求。

例如有效宽度为640，但`w_stride`为672：

```text
每行内存：
640个有效位置 + 32个对齐位置
```

创建Tensor内存时要保证容量覆盖`size_with_stride`；CPU或RGA写入时也要按照真实行跨度处理，不能把对齐区域误当成有效图像。

两种内存来源都要与这个值对齐：

```text
RKNN自己创建：
rknn_create_mem(ctx, required_size)

外部FD导入：
先确认DMA-BUF可用容量 >= required_size
→ rknn_create_mem_from_fd(..., required_size, offset)
```

这里的“对齐”表示交给RKNN使用的内存区域必须至少覆盖`required_size`，不是说底层DMA-BUF总容量只能与它完全相等。外部FD可以更大，但从`offset`开始必须留有足够空间，而且其dtype、layout和行stride还要与对应Tensor属性兼容。

内存还必须活得足够久：

- 普通指针由应用或OpenCV管理；
- `rknn_create_mem()`得到的内存最终使用`rknn_destroy_mem()`释放；
- 外部导入内存还要遵守原始FD和底层buffer的生命周期；
- NPU仍在读写时，任何一方都不能提前销毁或覆盖内存。

通过`rknn_create_mem()`创建或从FD导入的内存，其容量、dtype、layout和stride必须满足对应输入输出Tensor的当前属性。动态shape改变以后，要根据`RKNN_QUERY_CURRENT_INPUT_ATTR`和`RKNN_QUERY_CURRENT_OUTPUT_ATTR`返回的新`size_with_stride`重新检查；如果原来的容量或布局不再满足，就需要重新创建或重新导入合适的内存。若一开始已经准备了兼容所有支持shape的最大缓冲区，则不一定每次切换shape都重新导入。

## 5 RKNN推理：输入分支、共同运行和输出分支

### 5.1 先看通用推理结构

无论输入输出采用哪种内存形式，推理都可以整理成一条主线：

```text
动态模型可选步骤：
shape变化
→ 设置新shape
→ 必要时重新query当前属性
→ 必要时调整或重新创建内存

每帧正式推理：
普通输入 或 绑定输入
→ rknn_run()
→ 普通输出 或 绑定输出
→ 当前帧后处理
→ 当前帧资源处理
```

四种组合都可以存在：

| 输入分支 | 输出分支 | 是否可用 |
| --- | --- | --- |
| 普通输入 | 普通输出 | 可以 |
| 绑定输入 | 普通输出 | 可以 |
| 普通输入 | 绑定输出 | 可以 |
| 绑定输入 | 绑定输出 | 可以 |

输入采用导入的DMA-BUF，不代表输出也必须导入或绑定。第一次接入摄像头时，完全可以采用“绑定输入加普通输出”。

### 5.2 动态shape变化时先设置并重新查询当前属性

动态模型初始化时，已经按照第4.3节保存了作为基础属性的`input_attrs`。当应用需要切换到新的shape时，不应从空结构体开始填写，而应复制基础属性，只修改当前输入真正需要变化的维度。

假设第0个输入按照NCHW排列，需要改为`1×3×320×320`：

```cpp
// input_attrs来自初始化阶段的RKNN_QUERY_INPUT_ATTR查询。
// 复制一份可以保留index、name、fmt、type等基础描述，
// 同时避免直接破坏初始化查询结果。
std::vector<rknn_tensor_attr> shape_attrs =
    input_attrs;

shape_attrs[0].n_dims = 4;
shape_attrs[0].dims[0] = 1;
shape_attrs[0].dims[1] = 3;
shape_attrs[0].dims[2] = 320;
shape_attrs[0].dims[3] = 320;

// 多输入动态模型需要把所有输入当前使用的shape
// 一起放在shape_attrs数组中传给Runtime。
int ret = rknn_set_input_shapes(
    ctx,
    io_num.n_input,
    shape_attrs.data()
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "rknn_set_input_shapes失败，返回值=" +
        std::to_string(ret)
    );
}
```

如果输入是NHWC，维度顺序就要按照查询到的模型接口填写为`N、H、W、C`，不能继续套用NCHW的位置。

设置成功后，再查询当前输入和输出属性：

```cpp
std::vector<rknn_tensor_attr> current_input_attrs(
    io_num.n_input
);

for (uint32_t i = 0; i < io_num.n_input; ++i) {
    current_input_attrs[i] = {};
    current_input_attrs[i].index = i;

    ret = rknn_query(
        ctx,
        RKNN_QUERY_CURRENT_INPUT_ATTR,
        &current_input_attrs[i],
        sizeof(rknn_tensor_attr)
    );

    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "查询当前输入属性失败，index=" +
            std::to_string(i)
        );
    }
}

std::vector<rknn_tensor_attr> current_output_attrs(
    io_num.n_output
);

for (uint32_t i = 0; i < io_num.n_output; ++i) {
    current_output_attrs[i] = {};
    current_output_attrs[i].index = i;

    ret = rknn_query(
        ctx,
        RKNN_QUERY_CURRENT_OUTPUT_ATTR,
        &current_output_attrs[i],
        sizeof(rknn_tensor_attr)
    );

    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "查询当前输出属性失败，index=" +
            std::to_string(i)
        );
    }
}
```

重新查询的目的不是再次改变shape，而是取得设置完成后的真实`dims`、`size`、`size_with_stride`、`w_stride`以及输出shape。然后再根据当前属性处理内存：

```text
普通指针输入：
按照current_input_attrs准备正确字节数的Tensor

RKNN创建或外部导入内存：
检查现有rknn_tensor_mem是否满足当前size_with_stride和布局
→ 不满足则重新创建或重新导入
→ 满足则可以继续使用

绑定输入输出：
使用current_input_attrs和current_output_attrs完成当前shape的绑定
```

如果随后很多帧都继续使用`320×320`，不需要每帧重复这套流程。只有shape再次变化时，才重新执行：

```text
复制基础属性
→ 修改dims
→ rknn_set_input_shapes()
→ 查询CURRENT输入输出属性
→ 检查、创建或导入内存
→ 完成当前shape的输入输出准备
```

### 5.3 输入分支一：普通指针通过`rknn_inputs_set()`提交

`rknn_inputs_set()`的作用是把本次推理的普通应用指针、字节数、dtype和layout交给某个RKNN上下文。

函数形式为：

```cpp
int rknn_inputs_set(
    rknn_context context,
    uint32_t n_inputs,
    rknn_input inputs[]
);
```

下面只保留一个OpenCV案例。假设模型需要`640×640 RGB UINT8 NHWC`：

```cpp
cv::Mat image_bgr = cv::imread("test.jpg");
if (image_bgr.empty()) {
    throw std::runtime_error("图片读取失败");
}

cv::Mat resized_bgr;
cv::resize(
    image_bgr,
    resized_bgr,
    cv::Size(640, 640)
);

cv::Mat input_rgb;
cv::cvtColor(
    resized_bgr,
    input_rgb,
    cv::COLOR_BGR2RGB
);

// ROI等操作可能得到非连续Mat。
// rknn_inputs_set()需要明确的连续Tensor地址和字节数。
if (!input_rgb.isContinuous()) {
    input_rgb = input_rgb.clone();
}

rknn_input input{};
input.index = 0;
input.buf = input_rgb.data;
input.size = static_cast<uint32_t>(
    input_rgb.total() * input_rgb.elemSize()
);
input.type = RKNN_TENSOR_UINT8;
input.fmt = RKNN_TENSOR_NHWC;
input.pass_through = 0;

int ret = rknn_inputs_set(
    ctx,
    1,
    &input
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "rknn_inputs_set失败，返回值=" +
        std::to_string(ret)
    );
}
```

`input.index`表示交给模型的第几个输入。多输入模型需要根据第4.3节查询到的输入顺序、名称和属性，分别填写每个`rknn_input`。

`pass_through=0`允许Runtime根据`type`和`fmt`做必要转换，但不会替应用猜测BGR/RGB、letterbox或模型归一化方式。

### 5.4 输入分支二：通过`rknn_set_io_mem()`绑定Tensor内存

绑定输入使用：

```cpp
int rknn_set_io_mem(
    rknn_context ctx,
    rknn_tensor_mem* mem,
    rknn_tensor_attr* attr
);
```

三个参数分别表示：

- 绑定到哪个上下文；
- 使用哪块`rknn_tensor_mem`；
- 绑定到哪个模型Tensor，以及怎样解释这块内存。

最关键的是第三个参数。静态模型的输入属性已经在第4.3节查询并保存，这里直接取出对应入口：

```cpp
// input_attrs[0]来自初始化阶段的RKNN_QUERY_INPUT_ATTR查询。
rknn_tensor_attr& input_attr = input_attrs[0];
```

然后把第4.4节创建或导入的内存与该输入属性一起传入：

```cpp
int ret = rknn_set_io_mem(
    ctx,
    input_mem,
    &input_attr
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "绑定输入内存失败，返回值=" +
        std::to_string(ret)
    );
}
```

`input_mem`这个变量名不会让它自动变成输入。它之所以被Runtime当成输入，是因为传入的是通过`RKNN_QUERY_INPUT_ATTR`得到的完整输入Tensor描述。

固定使用一块输入内存时，初始化阶段绑定一次即可。每一帧只更新内存内容：

```text
把当前帧写入input_mem->virt_addr
→ 等待CPU、RGA或摄像头写入完成
→ rknn_run()
```

如果摄像头使用多块DMA-BUF，则每个FD在初始化阶段只导入一次，每帧根据buffer编号切换当前输入：

```cpp
const int buffer_index = dequeue_ready_buffer();

int ret = rknn_set_io_mem(
    ctx,
    imported_mems[buffer_index],
    &input_attr
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error("切换输入buffer失败");
}
```

切换时不需要单独解绑。新的调用会更新当前输入Tensor使用的内存；旧buffer仍保留在池中，等NPU不再读取后再归还摄像头。

多输入模型则为每个查询到的输入入口分别绑定：

```cpp
// input_attrs[0]来自第0个输入查询。
rknn_set_io_mem(
    ctx,
    image_mem,
    &input_attrs[0]
);

// input_attrs[1]来自第1个输入查询。
rknn_set_io_mem(
    ctx,
    image_shape_mem,
    &input_attrs[1]
);
```

调用顺序不是判断入口的依据，传入的`rknn_tensor_attr`才是关键。工程中仍建议按`0、1、2……`排列，方便检查。

### 5.5 两种输入最终都会调用`rknn_run()`

普通输入执行`rknn_inputs_set()`以后，或者绑定输入已经写入并同步完成以后，都进入相同的运行步骤：

```cpp
int ret = rknn_run(
    ctx,
    nullptr
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "rknn_run失败，返回值=" +
        std::to_string(ret)
    );
}
```

`rknn_run()`负责让当前上下文执行一次模型计算。API成功不代表检测结果一定正确，预处理、输入shape、颜色顺序和量化解释仍可能出错。

测量性能时应先预热，再分别统计输入准备、`rknn_run()`和输出处理耗时，同时记录NPU频率与core mask。

### 5.6 输出分支一：通过`rknn_outputs_get()`取得普通输出

普通输出让Runtime在本次推理中提供输出地址：

```cpp
std::vector<rknn_output> outputs(io_num.n_output);

for (uint32_t i = 0; i < io_num.n_output; ++i) {
    outputs[i] = {};
    outputs[i].index = i;

    // 请求转换成FLOAT32，便于第一次查看结果。
    outputs[i].want_float = 1;

    // 设为0表示输出缓冲区由Runtime提供。
    outputs[i].is_prealloc = 0;
}

int ret = rknn_outputs_get(
    ctx,
    io_num.n_output,
    outputs.data(),
    nullptr
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "rknn_outputs_get失败，返回值=" +
        std::to_string(ret)
    );
}
```

CPU通过`outputs[i].buf`读取结果。`want_float=1`便于调试，但可能增加转换开销；`want_float=0`保留模型原始输出类型，量化输出需要结合`zp`和`scale`解释。

使用结束后，本帧必须调用：

```cpp
rknn_outputs_release(
    ctx,
    io_num.n_output,
    outputs.data()
);
```

无论输入来自`rknn_inputs_set()`还是绑定的DMA-BUF，都可以选择这条普通输出路径。

### 5.7 输出分支二：直接读取绑定输出内存

如果希望输出也使用`rknn_tensor_mem`，先准备一块候选内存。下面假设第4.4节已经通过`rknn_create_mem()`得到`output_mem`。

输出绑定仍调用`rknn_set_io_mem()`，但第三个参数必须来自初始化阶段保存的输出查询结果：

```cpp
// output_attrs[0]来自初始化阶段的RKNN_QUERY_OUTPUT_ATTR查询。
rknn_tensor_attr& output_attr = output_attrs[0];

// output_mem本身没有输入或输出身份。
// 传入输出查询得到的output_attr以后，
// Runtime才把它与模型的第0个输出Tensor关联。
int ret = rknn_set_io_mem(
    ctx,
    output_mem,
    &output_attr
);

if (ret != RKNN_SUCC) {
    throw std::runtime_error(
        "绑定输出内存失败，返回值=" +
        std::to_string(ret)
    );
}
```

如果模型有多个输出，就为每个`output_attrs[i]`准备并绑定一块内存：

```cpp
for (uint32_t i = 0; i < io_num.n_output; ++i) {
    int ret = rknn_set_io_mem(
        ctx,
        output_mems[i],
        &output_attrs[i]
    );

    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "绑定输出失败，index=" +
            std::to_string(i)
        );
    }
}
```

`rknn_run()`完成后，CPU直接读取：

```cpp
for (uint32_t i = 0; i < io_num.n_output; ++i) {
    const void* output_data =
        output_mems[i]->virt_addr;

    run_model_postprocess(
        output_data,
        output_attrs[i]
    );
}
```

`run_model_postprocess()`只是表示当前模型自己的后处理函数，不是RKNN API。

这条路径不调用`rknn_outputs_get()`，也不调用`rknn_outputs_release()`。输出数据类型、layout、有效大小和stride按照绑定时使用的输出属性解释。如果输出是INT8，可以直接做量化后处理，或者使用：

```cpp
const float value =
    (static_cast<int32_t>(quantized_value) -
     output_attr.zp) *
    output_attr.scale;
```

`rknn_create_mem()`只创建通用Tensor内存；真正使它成为输出的，是`rknn_set_io_mem(ctx, output_mem, &output_attr)`中传入的输出属性描述。

### 5.8 当前帧和整个程序的资源处理

资源处理要区分普通输出、绑定内存和上下文。

普通输出是本帧临时取得的：

```text
rknn_outputs_get()
→ CPU使用outputs[i].buf
→ 当前帧rknn_outputs_release()
```

绑定内存通常跨帧存在：

```text
初始化时创建或导入
→ 多帧读写
→ 所有在途任务结束
→ rknn_destroy_mem()
```

上下文最后销毁：

```cpp
// 第一：确保没有NPU任务仍在使用绑定输入输出。
// 第二：销毁由当前上下文创建或导入的Tensor内存。
for (rknn_tensor_mem* mem : all_tensor_mems) {
    if (mem != nullptr) {
        rknn_destroy_mem(ctx, mem);
    }
}

// 第三：最后销毁模型上下文。
rknn_destroy(ctx);
```

DMA-BUF缓冲池中的buffer只有在摄像头、RGA和NPU都不再使用时才能归还。异步推理不能在任务刚发起后立即覆盖当前输入。

多线程并发时，建议每个推理线程持有独立`rknn_context`和独立输入输出内存。多个线程不要无保护地同时修改同一个上下文的当前绑定。
## 6 官方YOLO11 C++ Demo大致做了什么

### 6.1 官方Demo的整体职责

Rockchip Model Zoo提供了YOLO11 C++示例，可以用来确认官方怎样把模型特有预处理、RKNN Runtime调用和后处理连接起来：[YOLO11官方示例](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/yolo11)。

它完成的工作大致为：

```text
读取命令行参数和图片
→ 加载YOLO11 RKNN模型
→ 查询模型输入输出
→ resize或letterbox并准备输入
→ rknn_inputs_set()
→ rknn_run()
→ rknn_outputs_get()
→ 解码YOLO输出
→ 置信度筛选和NMS
→ 绘制并保存检测结果
→ 释放输出和模型资源
```

### 6.2 阅读官方Demo时先抓住RKNN主线

第一次阅读不要从图片工具和后处理公式开始，而是先找到：

```text
rknn_init
→ rknn_set_core_mask（如果当前示例使用）
→ RKNN_QUERY_IN_OUT_NUM
→ RKNN_QUERY_INPUT_ATTR / OUTPUT_ATTR
→ rknn_inputs_set
→ rknn_run
→ rknn_outputs_get
→ rknn_outputs_release
→ rknn_destroy
```

然后再区分其他部分：

- 图片读取和颜色转换；
- RGA或CPU resize；
- YOLO11检测头解码；
- NMS；
- 检测框绘制；
- 不同芯片和系统的兼容代码。

自己的项目不需要把官方Demo所有源文件全部复制进来。应该保留当前模型真正需要的输入输出约定和后处理算法，再用自己的工程结构封装Runtime。

### 6.3 官方高级API示例用来继续学习什么

RKNPU2中的`rknn_create_mem_demo`展示了`rknn_create_mem()`、`rknn_set_io_mem()`、stride处理和绑定输出内存：[官方零拷贝API示例](https://github.com/airockchip/rknn-toolkit2/blob/master/rknpu2/examples/rknn_api_demo/src/rknn_create_mem_demo.cpp)。

学习顺序建议是：

```text
官方YOLO11普通推理主线
→ 自己实现普通API封装
→ 结果正确并测量各阶段耗时
→ 阅读rknn_create_mem_demo
→ 根据瓶颈决定是否增加零拷贝
→ 最后再增加多上下文和多线程流水线
```

## 7 自己封装一个最小RKNN调用类

### 7.1 Demo边界

下面的Demo不依赖官方YOLO11 Demo源码，只依赖：

- `rknn_api.h`；
- `librknnrt.so`；
- C++标准库。

封装负责：

- 读取RKNN模型；
- 创建和销毁上下文；
- 选择NPU核心；
- 查询输入输出属性；
- 使用普通API完成一次推理；
- 把Runtime输出复制到应用内存后再释放。

为了突出RKNN调用，输入使用已经准备好的UINT8、NHWC RGB二进制Tensor，不在Demo中加入OpenCV和YOLO后处理。

### 7.2 头文件`simple_rknn_model.hpp`

```cpp
#pragma once

#include "rknn_api.h"

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

// 复制后的输出由应用自己拥有，不再依赖Runtime输出指针的生命周期。
struct OutputTensor {
    rknn_tensor_attr attr{};
    std::vector<uint8_t> data;
};

class SimpleRknnModel {
public:
    // model_path是板端.rknn文件路径。
    // core_mask明确指定当前上下文使用哪个或哪些NPU核心。
    SimpleRknnModel(const std::string& model_path,
                    rknn_core_mask core_mask);

    // 禁止复制，防止两个对象重复销毁同一个rknn_context。
    SimpleRknnModel(const SimpleRknnModel&) = delete;
    SimpleRknnModel& operator=(const SimpleRknnModel&) = delete;

    ~SimpleRknnModel();

    void print_model_info() const;

    // 这个简化接口只接收单个UINT8、NHWC图片Tensor。
    // want_float=true时让Runtime把输出转换为float32，方便调试。
    std::vector<OutputTensor> infer_uint8_nhwc(
        const uint8_t* input_data,
        std::size_t input_bytes,
        bool want_float
    );

    const rknn_tensor_attr& input_attr() const;

private:
    void query_model_info();
    static void print_tensor_attr(const char* kind,
                                  const rknn_tensor_attr& attr);

    rknn_context ctx_ = 0;
    std::vector<uint8_t> model_data_;
    rknn_sdk_version sdk_version_{};
    rknn_input_output_num io_num_{};
    std::vector<rknn_tensor_attr> input_attrs_;
    std::vector<rknn_tensor_attr> output_attrs_;
};
```

### 7.3 实现文件`simple_rknn_model.cpp`

```cpp
#include "simple_rknn_model.hpp"

#include <fstream>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <utility>

namespace {

// 把整个RKNN模型读入vector。
// vector作为类成员保存，直到rknn_context销毁后才释放。
std::vector<uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) {
        throw std::runtime_error("无法打开模型文件: " + path);
    }

    const std::streamsize file_size = file.tellg();
    if (file_size <= 0) {
        throw std::runtime_error("模型文件为空: " + path);
    }

    std::vector<uint8_t> data(static_cast<std::size_t>(file_size));
    file.seekg(0, std::ios::beg);

    if (!file.read(reinterpret_cast<char*>(data.data()), file_size)) {
        throw std::runtime_error("模型文件读取不完整: " + path);
    }

    return data;
}

const char* format_name(rknn_tensor_format format) {
    switch (format) {
        case RKNN_TENSOR_NCHW: return "NCHW";
        case RKNN_TENSOR_NHWC: return "NHWC";
        default: return "UNDEFINED";
    }
}

const char* type_name(rknn_tensor_type type) {
    switch (type) {
        case RKNN_TENSOR_FLOAT32: return "FLOAT32";
        case RKNN_TENSOR_FLOAT16: return "FLOAT16";
        case RKNN_TENSOR_INT8:    return "INT8";
        case RKNN_TENSOR_UINT8:   return "UINT8";
        case RKNN_TENSOR_INT16:   return "INT16";
        case RKNN_TENSOR_UINT16:  return "UINT16";
        case RKNN_TENSOR_INT32:   return "INT32";
        case RKNN_TENSOR_UINT32:  return "UINT32";
        default: return "OTHER";
    }
}

}  // namespace

SimpleRknnModel::SimpleRknnModel(
    const std::string& model_path,
    rknn_core_mask core_mask
) : model_data_(read_binary_file(model_path)) {

    // 第一步：根据模型二进制创建RKNN上下文。
    int ret = rknn_init(
        &ctx_,
        model_data_.data(),
        static_cast<uint32_t>(model_data_.size()),
        0,
        nullptr
    );

    if (ret != RKNN_SUCC) {
        ctx_ = 0;
        throw std::runtime_error(
            "rknn_init失败，返回值=" + std::to_string(ret)
        );
    }

    try {
        // 第二步：上下文创建成功后选择NPU核心。
        ret = rknn_set_core_mask(ctx_, core_mask);
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "rknn_set_core_mask失败，返回值=" +
                std::to_string(ret)
            );
        }

        // 第三步：查询当前Runtime真正看到的输入输出接口。
        query_model_info();
    } catch (...) {
        // 构造函数中途抛出异常时析构函数不会执行，
        // 所以必须在这里销毁已经创建成功的上下文。
        rknn_destroy(ctx_);
        ctx_ = 0;
        throw;
    }
}

SimpleRknnModel::~SimpleRknnModel() {
    if (ctx_ != 0) {
        rknn_destroy(ctx_);
        ctx_ = 0;
    }
}

void SimpleRknnModel::query_model_info() {
    int ret = rknn_query(
        ctx_,
        RKNN_QUERY_SDK_VERSION,
        &sdk_version_,
        sizeof(sdk_version_)
    );
    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "查询SDK版本失败，返回值=" + std::to_string(ret)
        );
    }

    ret = rknn_query(
        ctx_,
        RKNN_QUERY_IN_OUT_NUM,
        &io_num_,
        sizeof(io_num_)
    );
    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "查询输入输出数量失败，返回值=" + std::to_string(ret)
        );
    }

    input_attrs_.resize(io_num_.n_input);
    for (uint32_t i = 0; i < io_num_.n_input; ++i) {
        input_attrs_[i] = {};

        // query前先填写index，否则Runtime不知道要查询第几个输入。
        input_attrs_[i].index = i;

        ret = rknn_query(
            ctx_,
            RKNN_QUERY_INPUT_ATTR,
            &input_attrs_[i],
            sizeof(rknn_tensor_attr)
        );
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "查询输入Tensor失败，index=" + std::to_string(i) +
                "，返回值=" + std::to_string(ret)
            );
        }
    }

    output_attrs_.resize(io_num_.n_output);
    for (uint32_t i = 0; i < io_num_.n_output; ++i) {
        output_attrs_[i] = {};
        output_attrs_[i].index = i;

        ret = rknn_query(
            ctx_,
            RKNN_QUERY_OUTPUT_ATTR,
            &output_attrs_[i],
            sizeof(rknn_tensor_attr)
        );
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "查询输出Tensor失败，index=" + std::to_string(i) +
                "，返回值=" + std::to_string(ret)
            );
        }
    }
}

void SimpleRknnModel::print_tensor_attr(
    const char* kind,
    const rknn_tensor_attr& attr
) {
    std::cout << kind << "[" << attr.index << "]"
              << " name=" << attr.name
              << " dims=[";

    // 先按Runtime返回顺序打印全部维度，再结合fmt解释维度含义。
    for (uint32_t i = 0; i < attr.n_dims; ++i) {
        if (i != 0) {
            std::cout << ", ";
        }
        std::cout << attr.dims[i];
    }

    std::cout << "] fmt=" << format_name(attr.fmt)
              << " type=" << type_name(attr.type)
              << " size=" << attr.size
              << " size_with_stride=" << attr.size_with_stride
              << " w_stride=" << attr.w_stride
              << " zp=" << attr.zp
              << " scale=" << std::fixed << std::setprecision(8)
              << attr.scale << '\n';
}

void SimpleRknnModel::print_model_info() const {
    std::cout << "RKNN API版本: " << sdk_version_.api_version << '\n';
    std::cout << "RKNPU驱动版本: " << sdk_version_.drv_version << '\n';
    std::cout << "输入数量: " << io_num_.n_input
              << "，输出数量: " << io_num_.n_output << '\n';

    for (const auto& attr : input_attrs_) {
        print_tensor_attr("input", attr);
    }
    for (const auto& attr : output_attrs_) {
        print_tensor_attr("output", attr);
    }
}

const rknn_tensor_attr& SimpleRknnModel::input_attr() const {
    if (input_attrs_.empty()) {
        throw std::runtime_error("当前模型没有输入Tensor");
    }
    return input_attrs_.front();
}

std::vector<OutputTensor> SimpleRknnModel::infer_uint8_nhwc(
    const uint8_t* input_data,
    std::size_t input_bytes,
    bool want_float
) {
    if (input_data == nullptr || input_bytes == 0) {
        throw std::invalid_argument("输入Tensor为空");
    }
    if (io_num_.n_input != 1) {
        throw std::runtime_error("当前简单封装只支持单输入模型");
    }

    // 描述应用传给Runtime的数据，而不是直接照抄模型内部Tensor属性。
    rknn_input input{};
    input.index = 0;
    input.buf = const_cast<uint8_t*>(input_data);
    input.size = static_cast<uint32_t>(input_bytes);
    input.type = RKNN_TENSOR_UINT8;
    input.fmt = RKNN_TENSOR_NHWC;

    // 设为0，让Runtime根据type和fmt执行必要的输入转换。
    input.pass_through = 0;

    int ret = rknn_inputs_set(ctx_, 1, &input);
    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "rknn_inputs_set失败，返回值=" + std::to_string(ret)
        );
    }

    ret = rknn_run(ctx_, nullptr);
    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "rknn_run失败，返回值=" + std::to_string(ret)
        );
    }

    std::vector<rknn_output> runtime_outputs(io_num_.n_output);
    for (uint32_t i = 0; i < io_num_.n_output; ++i) {
        runtime_outputs[i] = {};
        runtime_outputs[i].index = i;
        runtime_outputs[i].want_float = want_float ? 1 : 0;

        // 让Runtime分配普通输出缓冲区。
        // outputs_get成功后必须调用outputs_release。
        runtime_outputs[i].is_prealloc = 0;
    }

    ret = rknn_outputs_get(
        ctx_,
        io_num_.n_output,
        runtime_outputs.data(),
        nullptr
    );
    if (ret != RKNN_SUCC) {
        throw std::runtime_error(
            "rknn_outputs_get失败，返回值=" + std::to_string(ret)
        );
    }

    try {
        std::vector<OutputTensor> copied_outputs;
        copied_outputs.reserve(io_num_.n_output);

        for (uint32_t i = 0; i < io_num_.n_output; ++i) {
            if (runtime_outputs[i].buf == nullptr) {
                throw std::runtime_error(
                    "Runtime返回空输出，index=" + std::to_string(i)
                );
            }

            OutputTensor output;
            output.attr = output_attrs_[i];

            // want_float=true时，每个输出元素都按float32占4字节。
            // want_float=false时，使用Runtime返回的原始输出字节数。
            const std::size_t bytes = want_float
                ? static_cast<std::size_t>(output_attrs_[i].n_elems) *
                      sizeof(float)
                : static_cast<std::size_t>(runtime_outputs[i].size);

            const auto* begin =
                static_cast<const uint8_t*>(runtime_outputs[i].buf);
            output.data.assign(begin, begin + bytes);
            copied_outputs.push_back(std::move(output));
        }

        // 输出已经复制到应用自己的vector，现在释放Runtime输出。
        rknn_outputs_release(
            ctx_, io_num_.n_output, runtime_outputs.data()
        );

        return copied_outputs;
    } catch (...) {
        // 即使复制期间抛出异常，也不能泄漏Runtime输出。
        rknn_outputs_release(
            ctx_, io_num_.n_output, runtime_outputs.data()
        );
        throw;
    }
}
```

### 7.4 简单调用程序`main.cpp`

```cpp
#include "simple_rknn_model.hpp"

#include <cstdint>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

// 读取已经完成解码、resize和颜色转换的UINT8 RGB Tensor。
std::vector<uint8_t> read_input_tensor(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) {
        throw std::runtime_error("无法打开输入Tensor文件: " + path);
    }

    const std::streamsize file_size = file.tellg();
    if (file_size <= 0) {
        throw std::runtime_error("输入Tensor文件为空: " + path);
    }

    std::vector<uint8_t> data(static_cast<std::size_t>(file_size));
    file.seekg(0, std::ios::beg);

    if (!file.read(reinterpret_cast<char*>(data.data()), file_size)) {
        throw std::runtime_error("输入Tensor文件读取失败: " + path);
    }

    return data;
}

// 把模型原始输出保存为二进制文件，供Python或其他程序继续分析。
void save_output_tensor(const std::string& path,
                        const std::vector<uint8_t>& data) {
    std::ofstream file(path, std::ios::binary);
    if (!file) {
        throw std::runtime_error("无法创建输出文件: " + path);
    }

    file.write(
        reinterpret_cast<const char*>(data.data()),
        static_cast<std::streamsize>(data.size())
    );

    if (!file) {
        throw std::runtime_error("输出Tensor保存失败: " + path);
    }
}

int main(int argc, char* argv[]) {
    if (argc != 3) {
        std::cerr
            << "用法: " << argv[0]
            << " <model.rknn> <input_rgb_uint8.bin>\n";
        return 1;
    }

    try {
        // 构造时加载模型、创建上下文、选择核心并查询接口。
        // 这里明确选择NPU核心0；需要测试其他核心时修改这个枚举即可。
        SimpleRknnModel model(argv[1], RKNN_NPU_CORE_0);
        model.print_model_info();

        const std::vector<uint8_t> input = read_input_tensor(argv[2]);

        // Demo提交UINT8数据，每个元素占1字节，
        // 所以输入文件字节数应等于输入Tensor元素数量。
        const std::size_t expected_bytes = model.input_attr().n_elems;
        if (input.size() != expected_bytes) {
            throw std::runtime_error(
                "输入文件大小不匹配：实际=" +
                std::to_string(input.size()) +
                "，期望=" + std::to_string(expected_bytes)
            );
        }

        // 第一次调试使用浮点输出，便于直接查看输出值。
        const std::vector<OutputTensor> outputs =
            model.infer_uint8_nhwc(input.data(), input.size(), true);

        // 这里只保存模型出口Tensor，不做YOLO检测框解码和NMS。
        for (std::size_t i = 0; i < outputs.size(); ++i) {
            const std::string output_path =
                "output_" + std::to_string(i) + "_float32.bin";

            save_output_tensor(output_path, outputs[i].data);
            std::cout << "已保存 " << output_path
                      << "，字节数=" << outputs[i].data.size()
                      << '\n';
        }

        return 0;
    } catch (const std::exception& error) {
        std::cerr << "程序执行失败: " << error.what() << '\n';
        return 1;
    }
}
```

### 7.5 编译和运行

第2部分的`CMakeLists.txt`已经把两个源文件和`librknnrt.so`连接起来。在板端执行：

```bash
# 生成构建目录并编译。
cmake -S . -B build
cmake --build build -j4

# 让Linux动态加载器找到随工程部署的RKNN Runtime动态库。
export LD_LIBRARY_PATH="$PWD/lib:$LD_LIBRARY_PATH"

# 第二个参数不是JPEG图片，而是预先准备好的UINT8 RGB Tensor文件。
./build/rknn_minimal_demo \
    model/yolo11n.rknn \
    input_640x640_rgb.bin
```

程序运行时可以在另一个终端查看核心负载和频率：

```bash
watch -n 0.5 'cat /sys/kernel/debug/rknpu/load; \
cat /sys/class/devfreq/fdab0000.npu/cur_freq'
```

如果`main()`中指定的是`RKNN_NPU_CORE_0`，连续推理时应该主要看到Core0活动。当前Demo只运行一次，执行时间可能短于监控刷新周期；测试占用率时应增加预热和循环推理，而不是用单帧负载做结论。

第一次运行需要检查：

- RKNN API和驱动版本是否打印；
- `rknn_set_core_mask()`是否成功；
- 输入输出数量是否正确；
- 输入文件字节数是否匹配；
- 输出shape、dtype、scale和zero-point是否符合当前模型；
- 是否正确生成各个原始输出文件。

## 8 本阶段总结

RK3588具有三个NPU核心。板端程序不仅要加载RKNN模型，还需要正确的`rknn_api.h`、AArch64版`librknnrt.so`和RKNPU驱动。通过devfreq和RKNPU debugfs可以观察NPU频率和三个核心的负载，但具体节点取决于开发板内核和驱动。

RKNN调用可以分为两大部分。初始化阶段负责读取模型、创建`rknn_context`、选择NPU核心、查询Tensor属性，并决定普通内存、应用预分配内存还是零拷贝内存；推理阶段负责准备输入、提交输入、运行模型、取得输出并释放本次输出资源。

零拷贝不强制要求先得到DMA-BUF FD。可以由`rknn_create_mem()`创建Tensor内存，也可以用`rknn_create_mem_from_fd()`导入摄像头、RGA等模块提供的共享内存。使用时仍要处理layout、dtype、stride、内存生命周期和硬件之间的同步。

官方YOLO11 Demo用于理解完整检测应用怎样连接预处理、RKNN Runtime和后处理；自己的最小工程只需要围绕Runtime建立清楚的封装。单上下文普通推理跑通后，再根据实际瓶颈选择零拷贝、组合多核或多个上下文并发。
