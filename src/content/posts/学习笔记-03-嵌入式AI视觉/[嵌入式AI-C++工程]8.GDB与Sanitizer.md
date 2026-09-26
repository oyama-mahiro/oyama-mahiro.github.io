---
title: '[嵌入式AI-C++工程] GDB与Sanitizer'
published: 2026-09-24T08:07:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍GDB与Sanitizer的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-8 GDB与Sanitizer

GNU调试器（GNU Debugger，GDB）用于暂停正在运行的程序，检查调用栈、变量和线程状态，也可以在程序崩溃后读取core dump。Sanitizer是一组由编译器插桩实现的运行时错误检测工具：地址消毒器（AddressSanitizer，ASan）主要检查内存访问错误，未定义行为消毒器（UndefinedBehaviorSanitizer，UBSan）检查部分未定义行为，线程消毒器（ThreadSanitizer，TSan）检查数据竞争。

本节的目标不是记住所有命令，而是形成固定排错流程：先判断错误属于崩溃、内存、未定义行为还是并发问题，再选择工具，取得调用栈和错误发生条件，最后修复边界、生命周期或同步关系。

## 1 调试构建、调试符号与可靠调用栈

### 1.1 `-g`调试符号与源码行号

编译器把C++源码转换成机器指令后，函数名、变量名和源码行号并不一定完整保留。`-g`要求GCC或Clang生成调试信息，使GDB和Sanitizer能够把指令地址还原为函数、文件和行号。

Linux下的基础调试构建：

```bash
g++ -std=c++17 -g main.cpp -o app_debug
```

`-g`不会自动修复错误，也不会启用ASan；它只提高诊断信息的可读性。发布二进制可能经过`strip`去除调试符号，因此生产环境通常需要单独保存与发布版本完全匹配的符号文件。

### 1.2 编译优化与栈帧保留

高优化会进行函数内联、删除无用变量和重排指令，所以GDB可能显示变量被优化掉，调用栈也可能缺少已经内联的函数。初学调试可以使用`-O0`；Sanitizer构建常使用`-O1`，在保留较接近真实行为的同时维持可读报告。

推荐组合：

```bash
g++ -std=c++17 -g -O1 -fno-omit-frame-pointer main.cpp -o app_debug
```

- `-O1`启用较轻量优化。
- `-fno-omit-frame-pointer`要求编译器保留栈帧指针，通常能改善调用栈展开。
- 即使保留栈帧，内联和尾调用等优化仍可能改变源码层面看到的调用关系。

Clang的ASan文档也推荐使用`-g`、`-O1`和`-fno-omit-frame-pointer`获得更清晰的调用栈，参见[AddressSanitizer官方文档](https://clang.llvm.org/docs/AddressSanitizer.html)。

### 1.3 可执行文件、动态库与core dump版本匹配

**核心转储（core dump）**记录进程崩溃时的内存映像、寄存器和线程状态。GDB还需要产生该core的可执行文件及相关动态库，才能把地址正确解析为函数和源码行。

分析时必须尽量匹配：

- 同一次构建生成的可执行文件；
- 相同版本和相同加载地址规则的动态库；
- 对应的调试符号；
- 相同或兼容的目标架构。

若程序已经重新编译，行号和函数地址可能改变。不能拿新二进制强行解释旧core，再根据错误行直接下结论。更稳妥的发布方式是为每个构建保存版本号、二进制、动态库和符号文件。

## 2 GDB断点、单步执行与变量检查

### 2.1 普通断点与条件断点

启动方式：

```bash
gdb --args ./app_debug input.txt
```

`--args`之后是程序及其命令行参数。进入GDB后，`break`可以按函数名或源码位置设置断点：

```text
(gdb) break process_frame
(gdb) break pipeline.cpp:86
```

当循环执行很多次、只在某个输入值下出错时，使用条件断点：

```text
(gdb) break process_frame if frame_index == 120
```

条件断点只有条件为真时才停下，但程序每次到达断点仍可能需要判断条件，因此热点循环中的条件断点可能明显拖慢运行。GDB官方文档说明，`break`可以按函数、行号或地址设置停止位置，并为断点添加条件，参见[GDB断点文档](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/gdb-man.html)。

### 2.2 `run`、`continue`、`next`与`step`

常用执行命令：

| 命令 | 作用 |
|---|---|
| `run`或`r` | 从头启动程序 |
| `continue`或`c` | 继续运行到下一个断点或信号 |
| `next`或`n` | 执行当前源码行，不进入普通函数调用 |
| `step`或`s` | 执行当前源码行，尽量进入被调用函数 |
| `finish` | 运行到当前函数返回 |

`next`和`step`都以源码行为单位，不保证只执行一条机器指令。多线程程序中，当前线程单步时其他线程也可能运行；不能把GDB下的一次线程调度当成正常运行时的固定顺序。

### 2.3 `print`与`info locals`

程序停下后可检查表达式：

```text
(gdb) print frame_index
(gdb) print buffer
(gdb) print buffer[0]
(gdb) info locals
```

- `print`计算并显示一个表达式。
- `info locals`列出当前栈帧中可见的局部变量。
- 若显示`<optimized out>`，说明该变量在当前优化构建中没有可直接恢复的位置；可以降低优化重新复现，但不要因此忽略其他调用栈证据。

对于指针，至少检查地址是否为空、它本应指向谁、对应所有者是否仍存活。只看到一个异常地址不能证明根因发生在当前行，错误可能更早就已经破坏了内存。

### 2.4 `bt`、`frame`与函数参数检查

`bt`是`backtrace`的缩写，用于显示当前线程的调用栈：

```text
(gdb) bt
(gdb) bt full
```

栈帧编号通常从当前停下位置的`#0`开始，`#1`是它的调用者，继续向上直到线程入口。使用`frame`切换：

```text
(gdb) frame 1
(gdb) info args
(gdb) info locals
```

实用阅读顺序是：先看`#0`发生了什么，再向`#1`、`#2`追踪错误参数从哪里传入。系统库中的`#0`可能只是最终检测或崩溃位置，第一条属于自己项目的栈帧通常更值得优先检查。GDB官方将backtrace定义为当前执行位置及其调用者组成的栈帧摘要，参见[GDB Backtrace文档](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/Backtrace.html)。

## 3 GDB多线程调试与core dump分析

### 3.1 `info threads`与`thread`线程切换

每个线程拥有自己的寄存器和调用栈。GDB停下后只选择其中一个作为当前线程，普通`bt`也只显示当前线程。

```text
(gdb) info threads
(gdb) thread 3
(gdb) bt
```

- `info threads`列出GDB已知的线程，行首`*`表示当前线程。
- `thread 3`切换到GDB编号为3的线程。
- 切换后，`bt`、`frame`和变量检查都从该线程视角执行。

收到崩溃信号的线程是重要现场，但不一定独自包含根因。例如另一个线程可能提前释放了它正在使用的对象。

### 3.2 `thread apply all bt`全部线程调用栈

查看全部线程调用栈：

```text
(gdb) thread apply all bt
(gdb) thread apply all bt full
```

它适合分析：

- 一个线程崩溃时其他线程正在做什么；
- 主线程是否卡在`join()`；
- 多个线程分别持有哪些锁；
- 条件变量等待是否形成永久阻塞。

阶段1-5第6.4节已经使用该命令分析双锁死锁。GDB官方也指出，`thread apply all backtrace`适合检查多线程core dump中的全部线程，参见[GDB线程文档](https://www.sourceware.org/gdb/current/onlinedocs/gdb.html/Threads.html)。

### 3.3 core dump生成、加载与版本匹配

Linux shell中可先允许当前会话生成core：

```bash
ulimit -c unlimited
./app_debug
```

传统环境可能在当前目录或系统指定目录生成`core`文件，加载方式为：

```bash
gdb ./app_debug core
```

进入GDB后先执行：

```text
(gdb) bt
(gdb) info threads
(gdb) thread apply all bt
```

部分systemd系统会集中保存core，可先用`coredumpctl list`查找记录，再使用该系统提供的`coredumpctl debug`进入调试。core路径和保留策略受系统配置影响；没有在当前目录看到`core`不代表程序没有崩溃。

GDB也可以对正在调试的进程执行`generate-core-file`或`gcore`保存快照。官方文档说明core dump记录进程内存和寄存器，主要用于事后分析，参见[GDB Core File Generation](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Core-File-Generation.html)。

## 4 AddressSanitizer、UndefinedBehaviorSanitizer与ThreadSanitizer的选择

### 4.1 ASan、UBSan与TSan的检测范围

| 工具 | 主要检测 | 不擅长解决 |
|---|---|---|
| ASan | 堆/栈越界、use-after-free、double-free等内存错误 | 数据竞争、所有业务逻辑错误 |
| UBSan | 有符号溢出、非法移位、部分空指针或未对齐访问等未定义行为 | 普通内存生命周期错误的完整追踪 |
| TSan | 多线程对同一内存的冲突访问且缺少同步 | 单线程越界、死锁的完整证明 |

ASan和TSan已经分别在阶段1-1第9～10节、阶段1-5第2节和第6.1节介绍。本节重点是固定工具选择和报告阅读顺序。

### 4.2 Sanitizer编译选项与独立构建目录

Sanitizer依赖编译器插桩，所以目标源码在编译阶段必须带`-fsanitize=...`，最终链接阶段也必须链接对应运行时。以阶段1-7的target级CMake配置为例：

```cmake
# 只给asan_demo加入ASan插桩、调试信息和可读调用栈所需选项。
target_compile_options(asan_demo PRIVATE
    -g -O1 -fsanitize=address -fno-omit-frame-pointer
)

# 链接阶段也启用ASan，使最终程序包含ASan运行时。
target_link_options(asan_demo PRIVATE -fsanitize=address)
```

这些选项适用于支持Sanitizer的GCC或Clang环境，不应无条件传播给所有编译器和正式发布target。实际项目应使用独立构建目录，例如：

```text
build-debug/
build-asan/
build-ubsan/
build-tsan/
build-release/
```

这样不会把不同插桩选项和CMake缓存混在一起，也便于确认正在运行哪个二进制。

### 4.3 ASan与TSan不能同时启用的限制

不要把ASan和TSan写成同一个构建：

```text
-fsanitize=address,thread   # 错误组合
```

两者使用不同的运行时和影子内存机制，GCC明确规定`-fsanitize=thread`不能与`-fsanitize=address`组合，参见[GCC Instrumentation Options](https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html)。

ASan和UBSan在很多GCC/Clang环境可以组合，但学习阶段仍建议先分开运行，避免一份报告同时混合多类问题。Sanitizer检测到严重错误后通常终止进程，因此不同故障应使用独立小程序或分别运行。

## 5 AddressSanitizer内存错误报告

### 5.1 堆缓冲区越界

申请4个`int`只允许访问索引`0`到`3`。访问索引`4`时，地址已经越过合法区域。ASan通常报告：

```text
ERROR: AddressSanitizer: heap-buffer-overflow
```

报告会说明访问大小、访问调用栈，以及目标地址位于已分配区域之前、内部还是之后。修复时应检查元素数量、字节数量、循环终止条件和外部输入，而不是简单扩大缓冲区掩盖计算错误。

### 5.2 释放后访问

use-after-free表示对象或缓冲区已经被释放，程序仍通过旧指针访问它。ASan报告通常包含：

1. 当前非法访问栈；
2. 对应内存的释放栈；
3. 对应内存的分配栈。

阶段1-1第10.4节已经详细解释影子内存和完整报告。本节只保留固定判断：先确认谁访问，再确认谁释放，最后回到分配点查清所有权本应交给谁。

### 5.3 重复释放

double-free表示同一块动态内存被释放两次。常见根因包括：

- 两个独立智能指针错误接管同一个裸指针；
- 资源类浅复制后，两个析构函数释放同一地址；
- 手工`delete`后，所有者析构时再次释放；
- 错误分支和统一清理路径重复执行。

ASan指出第二次释放位置和此前释放位置。修复应明确唯一所有者，优先使用阶段1-1、1-2中的RAII和智能指针，而不是只在第二次释放前增加一个临时布尔标记。

### 5.4 访问、分配与释放调用栈

阅读ASan报告的固定顺序：

1. 看第一行错误类型；
2. 找非法访问栈中第一条业务代码；
3. 确认读还是写、访问多少字节；
4. 看地址与合法内存区域的关系；
5. use-after-free再看释放栈和分配栈；
6. 修复后重新执行相同输入并运行相关测试。

不要只看报告最后的`SUMMARY`。它概括错误类型和位置，但分配、释放以及线程创建信息通常在报告中间。

## 6 UndefinedBehaviorSanitizer与ThreadSanitizer报告

### 6.1 UBSan未定义行为报告

未定义行为表示C++标准不规定程序之后必须怎样运行。程序没有立即崩溃，不代表行为正确。UBSan常见报告包括：

- 有符号整数溢出；
- 移位次数超出类型宽度；
- 部分空指针或未对齐访问；
- 无法由目标类型表示的运算。

基本构建：

```bash
g++ -std=c++17 -g -O1 -fsanitize=undefined \
  -fno-omit-frame-pointer ubsan_demo.cpp -o ubsan_demo
```

UBSan报告通常给出操作类型、参与运算的值和源码位置。修复方式是增加范围检查、使用合适类型或改正前置条件。Clang官方将UBSan定义为通过编译期插桩检测多类未定义行为的工具，参见[UndefinedBehaviorSanitizer文档](https://clang.llvm.org/docs/UndefinedBehaviorSanitizer.html)。

### 6.2 TSan数据竞争与冲突访问报告

数据竞争的判断规则已在阶段1-5第2.1节说明：两个线程并发访问同一内存位置，至少一个是写操作，并且访问之间没有建立同步关系。

TSan报告重点包括：

- 冲突内存地址；
- 当前读或写的线程与源码位置；
- 另一冲突访问的线程与源码位置；
- 相关线程的创建位置；
- 某些情况下还能显示关联互斥量。

修复时必须回到共享状态的同步设计：使用同一把互斥量保护完整不变量，或在适合单一状态时使用原子操作。不能通过增加`sleep`、改变日志或多运行几次来证明竞争消失。

### 6.3 未插桩代码与未执行路径的检测限制

Sanitizer只检查实际执行到并已插桩的代码：

- 测试未覆盖某条路径，就不会报告该路径中的错误；
- 预编译第三方库没有插桩，工具对其内部行为的可见性受限；
- TSan混入大量未插桩并发代码时可能漏报或产生难以解释的结果；
- “没有报告”只能说明本次输入和执行路径没有触发已检测错误。

Clang的TSan文档指出，相关代码通常需要使用`-fsanitize=thread`编译，未插桩模块可能导致漏报或误报，参见[ThreadSanitizer官方文档](https://clang.llvm.org/docs/ThreadSanitizer.html)。

## 7 GDB与Sanitizer专项故障Demo

### 7.1 GDB与core dump调用栈Demo

本Demo复用阶段1-5已经解释的`std::thread`和`join()`。主线程创建工作线程后等待；工作线程经过三层函数调用，把空指针交给写入函数，从而产生崩溃。输入固定，无命令行模式。

保存为`gdb_core_demo.cpp`：

```cpp
#include <thread>

// 把value写入调用方提供的目标地址。
// destination必须指向仍然存活且可写的int；本函数不拥有该地址。
void store_result(int* destination, int value) {
    // 故障注入：Demo会故意传入nullptr，使工作线程在这里崩溃。
    *destination = value;
}

// 根据has_output决定是否提供合法输出地址。
// 正常情况下destination指向当前函数栈上的result，并且只在函数返回前有效。
void process_request(bool has_output) {
    int result = 0;
    int* destination = has_output ? &result : nullptr;
    store_result(destination, 42);
}

// 工作线程入口，只负责建立清晰的调用层级并触发错误输入。
void worker_main() {
    process_request(false);
}

int main() {
    std::thread worker(worker_main);

    // 主线程在此等待工作线程；core中应能看到主线程位于join相关调用栈。
    worker.join();
    return 0;
}
```

依赖：Linux、GDB和支持C++17的GCC或Clang。构建：

```bash
g++ -std=c++17 -g -O0 -fno-omit-frame-pointer \
  -pthread gdb_core_demo.cpp -o gdb_core_demo
```

先在GDB中运行：

```bash
gdb ./gdb_core_demo
```

进入GDB后：

```text
(gdb) break store_result
(gdb) run
(gdb) print destination
(gdb) next
(gdb) bt
(gdb) frame 1
(gdb) info locals
(gdb) info threads
(gdb) thread apply all bt
```

应观察到`destination`为`nullptr`，工作线程调用关系为`worker_main → process_request → store_result`，主线程停在等待工作线程结束的位置。

再验证core dump：

```bash
ulimit -c unlimited
./gdb_core_demo
gdb ./gdb_core_demo core
```

如果系统没有在当前目录生成`core`，使用`coredumpctl list`确认是否由系统集中保存。验收标准是能指出崩溃线程、错误参数来源和主线程等待状态，而不是只记录最后崩溃行。

### 7.2 ASan堆越界Demo

本Demo只证明循环上界错误如何越过堆数组末尾。保存为`asan_overflow_demo.cpp`：

```cpp
#include <cstddef>

int main() {
    constexpr std::size_t element_count = 4;
    int* values = new int[element_count];

    // 合法索引只有0、1、2、3；当index等于4时写到分配区域之后。
    for (std::size_t index = 0; index <= element_count; ++index) {
        values[index] = static_cast<int>(index);
    }

    delete[] values;
    return 0;
}
```

构建和运行：

```bash
g++ -std=c++17 -g -O1 -fsanitize=address \
  -fno-omit-frame-pointer asan_overflow_demo.cpp -o asan_overflow_demo
./asan_overflow_demo
```

预期出现`heap-buffer-overflow`，并指出索引4对应的写操作以及数组分配位置。把循环条件改为`index < element_count`后重新构建，报告应消失。

### 7.3 ASan释放后访问Demo

本Demo与阶段1-1第10.4节关注同一种错误，但缩小为一个独立程序，只练习识别访问、释放和分配三条调用栈。保存为`asan_uaf_demo.cpp`：

```cpp
#include <iostream>

int main() {
    int* value = new int(42);

    // delete结束动态int的生命周期；value仍保存旧地址，但已经不能解引用。
    delete value;

    // 故障注入：读取已经释放的对象，ASan应在此报告use-after-free。
    std::cout << "released value = " << *value << '\n';
    return 0;
}
```

构建和运行：

```bash
g++ -std=c++17 -g -O1 -fsanitize=address \
  -fno-omit-frame-pointer asan_uaf_demo.cpp -o asan_uaf_demo
./asan_uaf_demo
```

预期出现`heap-use-after-free`。修复不是在访问前判断`value != nullptr`，因为`delete`不会自动把裸指针改成空；应删除释放后的访问，并让对象所有权覆盖实际使用时间。

### 7.4 UBSan有符号整数溢出Demo

保存为`ubsan_overflow_demo.cpp`：

```cpp
#include <iostream>
#include <limits>

int main() {
    // volatile让输入在运行时读取，避免示例被完全折叠为编译期常量。
    volatile int maximum = std::numeric_limits<int>::max();

    // 故障注入：int最大值再加1无法由int表示，属于有符号整数溢出。
    const int overflowed = maximum + 1;
    std::cout << overflowed << '\n';
    return 0;
}
```

构建和运行：

```bash
g++ -std=c++17 -g -O1 -fsanitize=undefined \
  -fno-omit-frame-pointer ubsan_overflow_demo.cpp -o ubsan_overflow_demo
./ubsan_overflow_demo
```

UBSan应报告有符号整数溢出及源码位置。修复时应在运算前检查范围，或根据业务范围使用能够表示结果的类型；不能依赖溢出后的偶然数值。

### 7.5 TSan数据竞争报告复核

复用阶段1-5第6.1节的`data_race_demo.cpp`，不重复创建另一份无锁计数器。使用独立TSan构建：

```bash
g++ -std=c++17 -g -O1 -fsanitize=thread \
  -fno-omit-frame-pointer -pthread data_race_demo.cpp -o data_race_tsan
./data_race_tsan
```

验收时从报告中指出：共享变量地址、两个冲突访问、各自线程和线程创建位置。再使用阶段1-5第6.2节的互斥量版本验证该数据竞争报告消失。最终计数偶然正确不能替代TSan报告和同步规则检查。

## 8 症状、工具、根因与修复检查表

| 症状或目标 | 优先工具 | 重点证据 | 常见根因 | 修复方向 |
|---|---|---|---|---|
| 程序崩溃 | GDB、core dump | 当前及上层frame、所有线程栈 | 空指针、非法状态、内存已提前损坏 | 修正输入验证、生命周期或状态转换 |
| 程序卡死 | GDB全部线程栈 | 每个线程停在哪个锁、等待或`join()` | 锁顺序、遗漏通知、退出顺序 | 统一锁顺序和关闭协议 |
| 堆或栈越界 | ASan | 非法访问位置和合法区域边界 | 长度、单位、循环上界错误 | 修正边界和尺寸计算 |
| use-after-free、double-free | ASan | 访问、释放和分配调用栈 | 所有权不清、悬空观察者、重复清理 | 使用RAII并明确唯一释放责任 |
| 有符号溢出等未定义行为 | UBSan | 运算值、行为类型和源码位置 | 缺少范围或前置条件检查 | 检查范围、改正类型与运算 |
| 数据竞争 | TSan | 两个冲突访问及线程创建栈 | 共享写入缺少同步 | 同一互斥量、合适原子或状态隔离 |

实际排错建议按以下顺序执行：

1. 保存可复现输入、日志、二进制版本和运行环境；
2. 崩溃先取得当前线程和全部线程调用栈；
3. 根据症状选择一个Sanitizer独立复现；
4. 从报告中的第一条业务代码向分配、释放、线程创建或上层调用追踪；
5. 修复根因后运行原输入、相关单元测试和对应Sanitizer构建；
6. 没有报告只代表已执行路径未触发已检测问题，不能代替代码边界、所有权和同步审查。

本阶段的最低掌握标准是：程序崩溃后先取得可靠`bt`和全部线程调用栈；看到内存错误、未定义行为或数据竞争时能够选择ASan、UBSan或TSan，并从报告中说清“在哪里发生、由什么状态造成、应该修改哪条工程规则”。
