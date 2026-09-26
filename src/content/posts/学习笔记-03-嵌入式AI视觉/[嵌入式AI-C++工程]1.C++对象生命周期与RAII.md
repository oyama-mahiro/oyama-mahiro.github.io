---
title: '[嵌入式AI-C++工程] C++对象生命周期与RAII'
published: 2026-09-24T08:00:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍C++对象生命周期与RAII的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-1 C++对象生命周期与资源获取即初始化（Resource Acquisition Is Initialization，RAII）

C++ 对象生命周期描述一个对象从开始存在、可以被合法使用，到结束存在的完整区间。本节重点讨论对象生命周期如何控制动态内存、文件、锁等外部资源的有效期，以及如何用资源获取即初始化（Resource Acquisition Is Initialization，RAII）把资源释放责任绑定到对象析构过程。

学习这一节后，需要能够回答三个工程问题：对象现在是否仍然存在、资源现在由谁拥有、当前指针是否仍然可以访问目标对象。后续的智能指针、移动语义、跨线程队列、图像缓冲区和推理资源管理都会建立在这三个判断上。

## 1 作用域、存储期、对象生命周期与资源生命周期

### 1.1 作用域与对象生命周期的区别

**作用域（scope）**描述一个名字可以在源代码的哪些位置被找到，主要是编译期概念。**对象生命周期（object lifetime）**描述对象从开始存在到结束存在的时间区间，主要关系到运行时能否合法访问对象。

下面的 `local_value` 只在花括号内可见，其对象也会在离开花括号时销毁：

```cpp
{
    int local_value = 42;
    // local_value 的名字在这里可见，对象也处于生命周期内。
}
// local_value 的名字不可见，对象也已经结束生命周期。
```

二者经常同时结束，但不能简单地当成同一个概念。例如，把局部对象的地址保存到外部指针后，外部仍然保存着一个地址值，但原对象已经销毁；此时“还能拿到地址”不等于“对象仍然存在”。

### 1.2 对象生命周期与外部资源有效期的区别

C++ 对象不一定就是它管理的资源。一个资源包装对象可能只保存一个指针、文件描述符或系统句柄，真正的资源位于堆、内核或设备中。

```text
ResourceBuffer 对象的生命周期
    构造完成 ─────────────── 析构开始
          │                    │
          └─ 申请动态内存      └─ 释放动态内存

动态内存资源的有效期
          申请成功 ─────────── delete[]
```

好的资源包装类会让两条时间线保持一致：构造成功后对象拥有资源，析构时对象释放资源。若资源先被手动释放，而对象仍认为自己拥有资源，析构时就可能重复释放；若对象销毁时没有释放资源，就会泄漏。

## 2 C++对象的常见存储期与销毁时机

### 2.1 自动存储期对象的创建与销毁

函数体或代码块中的普通局部对象通常具有**自动存储期（automatic storage duration）**。执行进入其声明位置时创建对象，控制流离开所在作用域时销毁对象。

```cpp
void process()
{
    std::string task_name = "decode";
    // 正常执行到函数末尾、提前 return 或异常向外传播时，
    // 已成功构造的 task_name 都会被析构。
}
```

自动存储期对象常被口语化地称为“栈对象”。这种说法便于交流，但 C++ 语言规则规定的是存储期和销毁时机，并不要求所有实现都必须以某一种具体栈结构保存对象。

### 2.2 动态存储期对象的创建与销毁

通过 `new` 表达式创建的对象具有**动态存储期（dynamic storage duration）**。它不会因为创建它的局部指针离开作用域而自动销毁，必须由对应的 `delete` 或 `delete[]` 结束生命周期。

```cpp
void unsafe_allocation()
{
    int* values = new int[128];
    // values 是局部指针；动态数组是它指向的另一块资源。
    // 如果这里直接 return，指针变量会消失，动态数组却不会自动释放。
    delete[] values;
}
```

`new` 与 `delete`、`new[]` 与 `delete[]` 必须正确配对。现代业务代码通常不应让裸指针直接承担动态资源所有权，而应优先使用标准容器或智能指针。本节为了观察底层机制，会在 `ResourceBuffer` 中直接管理一次动态数组；智能指针将在阶段 1-2 专门学习。

### 2.3 静态存储期与线程存储期对象的基本用途

具有**静态存储期（static storage duration）**的对象通常在程序开始阶段建立，并存活到程序正常结束。命名空间作用域变量、静态数据成员和使用 `static` 声明的局部变量都可能属于这一类。

具有 **线程存储期（thread storage duration）**的对象使用 `thread_local` 声明，每个线程拥有各自的实例，通常在线程退出时销毁。

现阶段需要记住两个风险：

- 不同翻译单元中的静态对象存在初始化、销毁次序依赖风险，不应让全局资源对象随意相互依赖。
- `thread_local` 对象的状态在线程之间不是同一份；若把其地址传给其他线程，必须重新检查目标线程使用期间原线程是否仍然存活。

## 3 构造函数、析构函数与对象销毁顺序

### 3.1 局部对象和成员对象的构造顺序

构造函数负责建立类的不变量，也就是对象一旦构造成功便必须满足的基本条件。成员对象按照它们在类中**声明的顺序**构造，而不是按照构造函数初始化列表中的书写顺序构造。

同一作用域内的局部对象通常按照执行经过声明的先后顺序构造：

```cpp
void run_task()
{
    Trace first{"first"};
    Trace second{"second"};
    // 构造顺序：first -> second
}
```

如果后一个对象的构造依赖前一个对象，应把依赖关系体现在成员声明顺序中，并让初始化列表也保持相同顺序，避免代码阅读者产生错误判断。

### 3.2 局部对象和成员对象的逆序析构

已经成功构造的同级对象通常按构造顺序的逆序销毁。上例离开函数时先析构 `second`，再析构 `first`。类的成员对象也按照成员声明顺序的逆序销毁。

这一规则允许后构造的对象依赖先构造的对象：依赖者先销毁，被依赖者后销毁。但如果析构函数把成员地址保存到其他长期存活的对象中，就会重新引入悬空访问风险。

析构函数用于释放对象仍然拥有的资源。它应当安全、可重复推理，并且通常不应向外抛出异常；尤其是在异常栈展开期间，若另一个析构函数再次抛出异常，程序会终止。

### 3.3 部分构造失败时已完成成员的销毁

如果构造函数执行到一半抛出异常，当前对象没有完成构造，因此该对象自身的析构函数不会执行；但是已经成功构造的基类和成员对象会自动按逆序析构。

这正是成员本身也应使用 RAII 类型的原因。若构造函数先用裸指针申请资源，随后另一项初始化抛出异常，而该资源尚未交给能自动清理的成员，就可能发生泄漏。

## 4 提前返回、异常与栈展开过程中的资源释放

### 4.1 正常返回和提前返回时的局部对象析构

只要控制流以 C++ 规定的正常方式离开作用域，已构造的自动对象都会析构。正常执行到函数末尾与提前 `return` 在这一点上没有区别。

```cpp
bool validate_task(bool input_valid)
{
    ResourceBuffer temporary_buffer{256};

    if (!input_valid) {
        // return 前 temporary_buffer 会析构，动态内存随之释放。
        return false;
    }

    return true;
}
```

因此，RAII 可以避免在每个错误分支前重复书写清理代码，也能降低以后新增返回路径时漏写清理的概率。

### 4.2 异常传播与栈展开

异常向外寻找匹配的 `catch` 处理器时，运行时会逐层退出函数作用域，并析构沿途已经成功构造的自动对象。这个过程称为**栈展开（stack unwinding）**。

```text
进入 load_task
  构造 ResourceBuffer
  调用 parse_config
    抛出异常
  parse_config 退出
  ResourceBuffer 析构并释放资源
load_task 退出
外层 catch 捕获异常
```

RAII 的关键价值不是“没有异常”，而是无论函数从哪条受支持的路径退出，释放责任都由析构函数统一执行。

### 4.3 不保证普通析构执行的异常终止方式

RAII 不能覆盖所有进程终止方式。例如，调用 `std::abort`、收到无法处理的强制终止信号、操作系统直接结束进程或机器掉电时，不能指望普通局部对象的析构函数运行。

所以需要区分两类保证：

- 内存、锁、进程内句柄等资源适合主要由 RAII 管理。
- 必须跨进程终止保存的数据，需要额外设计事务、刷盘、临时文件替换或恢复协议，不能只依赖析构函数。

## 5 RAII的概念、工作机制与适用资源

### 5.1 RAII如何绑定资源生命周期与对象生命周期

资源获取即初始化（Resource Acquisition Is Initialization，RAII）是一种 C++ 资源管理方式：对象在构造期间获得并记录资源所有权，在析构期间释放仍由它拥有的资源。

RAII 类型需要维持以下不变量：

1. 构造成功后，对象处于可以安全使用的状态。
2. 任意时刻都能明确对象是否拥有资源。
3. 析构时只释放当前仍然拥有的资源。
4. 所有权转移后，源对象不再释放已经转出的资源。

RAII 不是某一个类或函数，而是一种把释放规则写进类型行为的设计方法。

### 5.2 RAII如何统一多条函数退出路径

不使用 RAII 时，每个错误分支都要手动清理：

```cpp
void* resource = acquire_resource();
if (!step_one(resource)) {
    release_resource(resource);
    return;
}
if (!step_two(resource)) {
    release_resource(resource);
    return;
}
release_resource(resource);
```

分支越多，越容易出现漏释放、重复释放或者释放次序错误。RAII 把清理放在析构函数中，业务代码只负责表达流程。提前返回和异常栈展开都会触发同一个清理入口。

### 5.3 动态内存、文件、锁和系统句柄的RAII管理

RAII 可以管理任何具有“获取—使用—释放”配对关系的资源：

- 动态内存：标准容器或智能指针负责释放。
- 文件流：文件流对象析构时关闭其拥有的文件。
- 互斥锁：锁守卫对象离开作用域时解锁。
- 文件描述符、映射内存和第三方库句柄：通常需要编写小型包装类型，在析构函数中调用对应释放接口。

需要注意，资源的释放方式可能不同，不能对所有句柄统一调用 `delete`。包装类型必须知道资源来自哪个接口、应该用哪个配对接口释放，以及哪个特殊值表示“当前不拥有资源”。

## 6 所有权、非拥有型观察关系与裸指针

### 6.1 唯一所有权、共享所有权与非拥有型观察关系

**所有权（ownership）**回答“谁负责保证资源仍然有效，并最终结束其生命周期”。常见关系包括：

- 唯一所有权：同一时刻只有一个拥有者负责释放资源，所有权可以转移。
- 共享所有权：多个拥有者共同延长资源生命周期，最后一个拥有者离开时释放资源。
- 非拥有型观察关系：只在约定的时间内访问资源，不负责释放，也不能延长资源生命周期。

选择哪一种关系取决于业务生命周期，而不是取决于语法是否方便。能使用唯一所有权时不应无理由升级为共享所有权，因为共享关系更难看出资源究竟应该何时结束。

### 6.2 裸指针不等于资源所有者

裸指针只是保存地址的语言工具，它本身没有自动释放行为，也没有说明所有权。裸指针既可能是遗留代码中的拥有者，也可能只是临时观察者。

```cpp
void inspect_bytes(const std::byte* data, std::size_t size);
```

这个接口中的 `data` 通常应被理解为非拥有型观察指针：函数在调用期间读取数据，不负责 `delete[] data`，也不应把该地址保存到超过调用期的位置。但这种约定必须由接口文档、类型或调用关系明确表达。

所以，“出现裸指针”不能直接推出“发生内存泄漏”。真正需要检查的是：

1. 谁创建了资源？
2. 谁保证访问期间资源有效？
3. 所有权是否发生转移？
4. 谁在什么时机调用正确的释放操作？

### 6.3 跨函数和跨队列传递对象时的生命周期边界

同步函数通常只在调用期间使用参数，而队列、回调和异步任务可能在原函数返回后才使用数据。只要对象跨越异步边界，就必须明确传递的是资源所有权、共享所有权，还是一个有外部生命周期保证的观察关系。

例如，把局部图像缓冲区的裸指针放入异步队列后立即返回，消费者稍后访问时，生产者的局部拥有者可能已经销毁。这不是“队列偶尔不稳定”，而是观察者活得比资源更久。阶段 1-5 和阶段 1-6 会继续讨论线程与有限队列中的所有权传递。

## 7 复制、移动、Rule of Zero与Rule of Five

### 7.1 资源类浅复制导致的重复释放

如果一个类只保存动态内存地址，而复制操作直接复制这个地址，两个对象会同时认为自己拥有同一资源：

```text
复制前：owner_a ──拥有──> buffer

浅复制后：owner_a ──认为拥有──> buffer
          owner_b ──认为拥有──> buffer

析构时：owner_b 释放 buffer
        owner_a 再次释放同一地址 -> 重复释放
```

资源类必须明确选择一种复制策略：执行真正的深复制、建立经过设计的共享所有权，或者直接禁止复制。不能让编译器生成的逐成员复制在无意中决定资源语义。

### 7.2 移动操作中的所有权转移与源对象状态

移动操作用于把资源所有权从源对象转给目标对象，而不是复制底层资源。典型过程是：

1. 目标对象取得源对象保存的资源地址和大小。
2. 源对象的地址被设为 `nullptr`，大小被设为零。
3. 目标对象以后负责释放资源。
4. 源对象仍然可以析构或重新赋值，但不能继续当作原资源的拥有者使用。

移动后的对象必须保持**有效但状态未指定（valid but unspecified state）**。对自己编写的 `ResourceBuffer`，可以进一步规定移动后为空；但不能把这一自定义约定未经说明地套到所有标准库类型上。

### 7.3 Rule of Zero的用途与优先使用原则

**零法则（Rule of Zero）**建议：业务类优先组合已经能正确管理资源的类型，使业务类不必亲自实现析构函数、复制构造函数、复制赋值运算符、移动构造函数和移动赋值运算符。

例如，如果缓冲区只需要普通连续内存，使用 `std::vector<std::byte>` 作为成员通常比直接保存 `new[]` 返回的地址更安全。容器已经定义了析构、复制和移动行为，外层业务类可以依赖编译器生成的特殊成员函数。

Rule of Zero 是日常业务代码的优先方向。本节手写 `ResourceBuffer` 是为了学习资源包装器的边界，不代表所有缓冲区都应该重新实现一套内存管理。

### 7.4 Rule of Five的用途与需要检查的特殊成员函数

**五法则（Rule of Five）**提醒：如果一个类直接拥有资源，并且必须自定义某个资源相关的特殊成员函数，就要系统检查下面五个操作的语义：

1. 析构函数。
2. 复制构造函数。
3. 复制赋值运算符。
4. 移动构造函数。
5. 移动赋值运算符。

这不是要求每个类都机械地手写五个函数。例如，独占资源类可以明确删除两个复制操作，再实现析构与两个移动操作。真正要求是：每条对象创建、赋值、转移和销毁路径都不能让资源出现零个释放者或多个释放者。

## 8 常见生命周期错误及其区别

### 8.1 悬空指针与野指针

**悬空指针（dangling pointer）**曾经指向一个有效对象，但目标对象已经销毁或存储空间已经释放。指针中可能仍保留原地址，因此打印地址看起来正常，但通过它访问对象已经是未定义行为。

```cpp
int* dangling = nullptr;
{
    int local_value = 7;
    dangling = &local_value;
}
// dangling 保存过一个合法地址，但 local_value 已经结束生命周期。
```

**野指针（wild pointer）**通常指没有经过可靠初始化、地址来源不明的指针：

```cpp
int* wild;
// 在给 wild 赋予合法地址前读取或解引用它，行为未定义。
```

二者都不能解引用，但根因不同：悬空指针的问题是目标生命周期已经结束，野指针的问题是从未建立可靠的指向关系。

### 8.2 Use-after-free与重复释放

**释放后使用（use-after-free）**是指资源已经释放后，程序仍通过旧指针读取或写入该存储区域。悬空指针描述一种指针状态，use-after-free 描述一次通过该状态执行的非法操作。

**重复释放（double free）**是对同一资源执行两次释放。常见原因包括浅复制两个拥有者、手动释放后未清除所有权状态，或者错误路径和正常路径都执行清理。

两者都属于**未定义行为（undefined behavior）**：C++ 不保证固定结果。程序可能立刻崩溃，也可能暂时正常、稍后破坏其他数据，或者只在优化构建和特定内存布局下出现问题。因此，不能用“这次没有崩溃”证明代码正确。

### 8.3 内存泄漏与所有权路径丢失

**内存泄漏（memory leak）**表示动态内存仍然被占用，但程序已经没有可靠路径在合适时机释放它。例如，拥有资源的唯一裸指针被新地址覆盖：

```cpp
int* owner = new int[128];
owner = new int[256];
// 第一块数组的地址丢失，无法再对它执行 delete[]。
delete[] owner;
```

泄漏与悬空的方向相反：

- 泄漏：资源还活着，但拥有者或释放路径丢了。
- 悬空：观察地址还在，但资源已经不活着。

排查时应画出“创建—拥有—转移—释放”的链路，而不是只搜索 `new` 和 `delete` 的数量是否相等。

## 9 生命周期错误的排查方法

### 9.1 根据创建、转移、观察和释放过程绘制所有权变化

面对生命周期问题，先对每个资源记录四类事件：

1. 创建：资源在哪里获得，失败时返回什么。
2. 拥有：当前谁负责维持和释放资源。
3. 转移或共享：责任是否跨对象、函数、线程或队列变化。
4. 释放：哪个操作结束资源有效期，释放后还有哪些观察者。

对本节的移动对象，可以画成：

```text
创建：source ──拥有──> buffer

移动：source ──空，不拥有──> nullptr
      target ──拥有────────> buffer

销毁：target ──释放────────> buffer 生命周期结束
      source 析构时看到 nullptr，不执行第二次释放
```

如果图中某一时刻没有释放责任人，可能泄漏；如果同时存在两个未经协调的唯一拥有者，可能重复释放；如果观察者延伸到释放点之后，可能发生 use-after-free。

### 9.2 根据崩溃症状与调用栈缩小错误范围

生命周期错误常见症状包括：

- 崩溃位置在普通读写语句，而真正的错误发生在更早的释放操作。
- 析构或 `delete` 中崩溃，原因可能是之前已经释放过同一地址。
- Debug 构建正常，优化构建失败，或加入日志后问题暂时消失。
- 数据偶尔被覆盖，错误随输入规模、线程调度或内存分配顺序变化。

建议按以下顺序排查：

1. 保留可复现输入，减少无关线程和分支。
2. 确认第一次分配位置和理论释放责任人。
3. 检查所有复制、移动、回调捕获和异步队列入口。
4. 检查实际释放后是否仍有裸指针、引用、迭代器或视图。
5. 使用内存检测工具获得分配、释放和非法访问的调用栈。

### 9.3 地址消毒器（AddressSanitizer，ASan）的作用与诊断信息

地址消毒器（AddressSanitizer，ASan）是一种通过编译器插桩检测内存访问错误的工具。它能够帮助定位堆 use-after-free、越界访问、重复释放等问题。插桩构建会增加运行时间和内存开销，因此通常用于开发、测试和持续集成中的诊断构建，而不是直接当作发布版本。

以 GCC 或 Clang 为例，常用编译选项如下：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic \
    -g -O1 -fsanitize=address -fno-omit-frame-pointer \
    resource_buffer.cpp -o resource_buffer
```

各选项的作用：

- `-g`：保留调试信息，使报告能够映射到源文件和行号。
- `-O1`：保留一定优化，同时让调试行为相对容易观察。
- `-fsanitize=address`：启用 ASan 插桩并链接其运行时。
- `-fno-omit-frame-pointer`：保留帧指针，通常能得到更完整的调用栈。

发现错误时，应优先阅读三处证据：非法访问发生在哪里、对应内存在哪里释放、最初在哪里分配。修复后要使用同一输入重新运行安全路径与故障路径，不能只删除触发语句来让报告消失。

## 10 ResourceBuffer生命周期与ASan验证Demo

### 10.1 ResourceBuffer的资源所有权与类接口设计

这个微型 Demo 回答两个问题：RAII 是否能覆盖正常返回、提前返回和异常路径，以及所有权转移后旧观察指针为何会悬空。

依赖与输入如下：

- 语言：C++17。
- 依赖：只使用 C++ 标准库。
- 推荐平台：Linux，使用支持 ASan 的 GCC 或 Clang。
- 输入：命令行模式 `safe`、`early`、`exception`、`move` 或 `uaf`。
- 输出：资源分配、移动、释放日志；`uaf` 模式额外输出 ASan 错误报告。

将以下代码保存为 `resource_buffer.cpp`：

```cpp
#include <cstddef>
#include <cstdlib>
#include <exception>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

class ResourceBuffer {
public:
    // explicit 禁止把整数隐式转换成 ResourceBuffer，避免把“字节数”误当成对象。
    // 构造成功后的类不变量：
    // 1. size_ == 0 时，data_ 可以为 nullptr；
    // 2. size_ > 0 时，data_ 指向由本对象独占的一块 new[] 动态数组；
    // 3. 这块动态数组最终必须且只能由一个 ResourceBuffer 释放。
    explicit ResourceBuffer(std::size_t size)
        // new std::byte[size] 只申请原始字节存储，不做业务数据初始化。
        // 申请失败时 new 会抛出 std::bad_alloc，构造不会完成，也就没有资源需要本类析构。
        : data_(size == 0 ? nullptr : new std::byte[size]), size_(size)
    {
        std::cout << "allocate " << size_ << " bytes at "
                  << static_cast<void*>(data_) << '\n';
    }

    // 析构函数是 RAII 的统一释放入口。
    // noexcept 表示析构过程不会向外传播异常，适合正常退出和异常栈展开两种路径。
    ~ResourceBuffer() noexcept
    {
        // 只有当前仍拥有资源的对象才会得到非空地址。
        // delete[] nullptr 是安全的，因此移动后的空对象也能正常析构。
        std::cout << "release " << size_ << " bytes at "
                  << static_cast<void*>(data_) << '\n';
        delete[] data_;
    }

    // 该类表示独占资源。若允许默认复制，两个对象会重复释放同一地址。
    ResourceBuffer(const ResourceBuffer&) = delete;
    ResourceBuffer& operator=(const ResourceBuffer&) = delete;

    // 移动构造不复制 64 字节数据，只把动态数组的所有权从 other 转给当前对象。
    // std::exchange 在取出旧值的同时把源对象重置为空，避免两个对象同时拥有同一地址。
    // noexcept 很重要：标准容器调整容量时，通常更愿意使用不会抛异常的移动构造。
    ResourceBuffer(ResourceBuffer&& other) noexcept
        : data_(std::exchange(other.data_, nullptr)),
          size_(std::exchange(other.size_, 0))
    {
        std::cout << "move-construct, new owner holds "
                  << static_cast<void*>(data_) << '\n';
    }

    ResourceBuffer& operator=(ResourceBuffer&& other) noexcept
    {
        // 防止 buffer = std::move(buffer) 这种自移动赋值先释放自己的资源，
        // 再从已经被修改的同一个对象中接管资源。
        if (this == &other) {
            return *this;
        }

        // 目标对象可能已经拥有资源，接管新资源前必须先释放旧资源。
        // 这次 delete[] 结束的是目标对象“原资源”的生命周期。
        delete[] data_;

        // 接管 other 的资源后立刻将 other 置为空。
        // 移动完成后：*this 是唯一拥有者，other 仍可析构或重新赋值，但不再拥有原资源。
        data_ = std::exchange(other.data_, nullptr);
        size_ = std::exchange(other.size_, 0);
        std::cout << "move-assign, new owner holds "
                  << static_cast<void*>(data_) << '\n';
        return *this;
    }

    // data() 返回非拥有型观察指针：调用者可以访问字节，但没有得到 delete[] 的责任。
    // 该指针只有在当前 ResourceBuffer 仍拥有资源时才有效；对象析构或再次被移动后会失效。
    std::byte* data() noexcept { return data_; }
    const std::byte* data() const noexcept { return data_; }
    std::size_t size() const noexcept { return size_; }

    void fill(std::byte value)
    {
        // 循环访问范围严格为 [0, size_)。
        // 对移动后的空对象调用 fill 时 size_ 为 0，不会解引用 nullptr。
        for (std::size_t index = 0; index < size_; ++index) {
            data_[index] = value;
        }
    }

private:
    // data_ 非空时，本对象是这块动态数组的唯一拥有者。
    // 两个成员共同描述所有权状态，移动操作必须同时更新它们。
    std::byte* data_{nullptr};
    std::size_t size_{0};
};

void run_safe_path()
{
    // buffer 是当前函数的自动存储期对象，也是动态数组的唯一拥有者。
    ResourceBuffer buffer{64};
    buffer.fill(std::byte{0x2A});
    std::cout << "safe path finished\n";
    // 执行到函数末尾：先调用 buffer 的析构函数，再返回调用者。
}

void run_early_return_path(bool input_valid)
{
    ResourceBuffer buffer{64};
    if (!input_valid) {
        std::cout << "return early\n";
        // return 只提前结束业务流程，不会跳过自动对象的析构。
        return; // 离开作用域前，buffer 仍会自动析构。
    }
    buffer.fill(std::byte{0x2A});
}

void run_exception_path()
{
    ResourceBuffer buffer{64};
    std::cout << "throw exception\n";
    // 异常离开本函数时发生栈展开：buffer 先析构，异常再到达 main 中的 catch。
    throw std::runtime_error{"injected parse failure"};
}

void run_move_path()
{
    // source 最初是动态数组的唯一拥有者。
    ResourceBuffer source{64};
    std::byte* observer = source.data(); // 只观察，不拥有，也不负责释放。

    // std::move 本身不移动资源，只把 source 转换成可被移动构造函数接收的右值。
    // 真正的所有权转移发生在 ResourceBuffer 的移动构造函数内。
    ResourceBuffer target{std::move(source)};
    target.fill(std::byte{0x2A});

    // observer 与 target.data() 数值相同，因为底层资源没有复制或搬迁。
    // source.data() 应为 nullptr，证明 source 已经不再拥有原资源。
    std::cout << "observer = " << static_cast<void*>(observer) << '\n'
              << "source.data = " << static_cast<void*>(source.data()) << '\n'
              << "target.data = " << static_cast<void*>(target.data()) << '\n';
    // 函数结束时按构造逆序析构：target 先释放原资源，source 再安全释放 nullptr。
}

void run_use_after_free_path()
{
    // observer 只是地址观察者。把它初始化为 nullptr，避免它在赋值前成为野指针。
    std::byte* observer = nullptr;
    {
        // owner 的生命周期只覆盖这一层花括号。
        ResourceBuffer owner{64};
        observer = owner.data(); // observer 不会延长 owner 或动态数组的生命周期。
        owner.fill(std::byte{0x2A});
    } // owner 在这里析构，observer 从这里开始成为悬空指针。

    // 这是有意注入的错误，只用于观察 ASan 报告。
    // 不要在没有 ASan 的生产程序中运行或模仿该访问。
    // 此时 observer 保存的地址值可能看起来没有变化，但它指向对象的生命周期已经结束。
    // 写入第 0 个字节会形成一次“大小为 1 的堆释放后写入”。
    observer[0] = std::byte{0x11};
    std::cout << "unexpected value = " << std::to_integer<int>(observer[0]) << '\n';
}

int main(int argc, char* argv[])
{
    // 未提供参数时默认走安全路径，避免用户直接运行程序就触发故意制造的未定义行为。
    const std::string mode = argc > 1 ? argv[1] : "safe";

    try {
        // 每个模式放在独立函数中，使构造、退出和析构边界更容易从日志与调用栈中观察。
        if (mode == "safe") {
            run_safe_path();
        } else if (mode == "early") {
            run_early_return_path(false);
        } else if (mode == "exception") {
            run_exception_path();
        } else if (mode == "move") {
            run_move_path();
        } else if (mode == "uaf") {
            run_use_after_free_path();
        } else {
            std::cerr << "usage: " << argv[0]
                      << " [safe|early|exception|move|uaf]\n";
            return EXIT_FAILURE;
        }
    } catch (const std::exception& error) {
        // 这里只处理 exception 模式注入的标准异常。
        // ASan 检测到的 use-after-free 不是 C++ 异常，不能被这个 catch 捕获。
        std::cout << "caught: " << error.what() << '\n';
    }

    return EXIT_SUCCESS;
}
```

`std::exchange` 是 C++ 标准库 `<utility>` 中的值替换工具：它把对象设为新值，同时返回替换前的旧值。移动构造函数用它取得源对象的地址，并立即把源地址设为 `nullptr`，使所有权变化集中在同一个表达式中。

### 10.2 正常返回、提前返回与异常路径的析构验证

在 Linux 中编译并依次运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic \
    -g -O1 -fsanitize=address -fno-omit-frame-pointer \
    resource_buffer.cpp -o resource_buffer

./resource_buffer safe
./resource_buffer early
./resource_buffer exception
```

三种模式都应该出现一次 `allocate` 和一次对应的 `release`：

- `safe`：执行到函数末尾，局部对象析构。
- `early`：在 `return` 前析构局部对象。
- `exception`：抛出异常后进行栈展开，先析构局部对象，再进入 `catch`。

重点检查 `exception` 模式的输出顺序：`throw exception` 之后应先看到 `release`，然后才看到外层的 `caught`。这证明资源清理发生在异常传播途中，而不是由 `catch` 手动完成。

### 10.3 ResourceBuffer移动前后的所有权变化

运行移动模式：

```bash
./resource_buffer move
```

预期观察到：

1. `source` 分配一块动态内存。
2. `target` 移动构造并取得同一个地址。
3. `source.data()` 变为 `nullptr`，`target.data()` 等于移动前的资源地址。
4. 函数退出时先析构 `target`，它释放 64 字节资源。
5. 随后析构 `source`，它只对 `nullptr` 执行安全的 `delete[]`，不会重复释放。

这里的 `observer` 仍指向同一资源，但它没有取得所有权。移动之后，只要 `target` 仍然存活，`observer` 暂时仍可指向有效内存；`target` 一旦销毁，`observer` 就会悬空。这说明移动改变的是拥有者，不会自动更新或使所有外部观察指针失效为 `nullptr`。

### 10.4 Use-after-free故障注入与ASan报告分析

故障模式应单独运行，因为 ASan 检测到错误后通常会终止当前进程：

```bash
./resource_buffer uaf
```

下面使用一次真实运行报告说明阅读方法。示例把源文件保存成了 `main.cpp`、可执行文件命名为 `main`，因此路径和前面的命令不同，但不影响分析：

```text
allocate 64 bytes at 0x606000000020
release 64 bytes at 0x606000000020
=================================================================
==4339==ERROR: AddressSanitizer: heap-use-after-free
on address 0x606000000020
WRITE of size 1 at 0x606000000020 thread T0
    #0 run_use_after_free_path() main.cpp:119
    #1 main main.cpp:137
```

**第一步：先用一句话确定错误类型、访问方式和线程。**

- `heap-use-after-free`：访问的是堆内存，而且访问发生时该内存已经被释放。
- `WRITE of size 1`：这是一次写操作，写入大小为 1 字节。它正好对应 `observer[0] = std::byte{0x11};`。
- `at 0x606000000020`：本次写入的目标地址。
- `thread T0`：错误发生在编号为 T0 的线程。这个程序没有创建其他线程，因此 T0 就是主线程。
- `pc`、`bp`、`sp` 分别是程序计数器、基址指针和栈指针等底层寄存器信息。日常定位时不必先解析它们，应优先看错误类型和带源码行号的调用栈。

紧跟在错误摘要后的第一组调用栈描述“错误访问是怎样执行到这里的”。编号越小越接近错误现场：

```text
#0 run_use_after_free_path() main.cpp:119
#1 main main.cpp:137
```

`#0` 是最重要的一帧：`main.cpp:119` 在 `run_use_after_free_path()` 中执行了非法写入。`#1` 表示该函数由 `main.cpp:137` 的 `main` 调用。排查时应先打开 `#0` 对应源码，不要从最底部的 C 运行库入口开始看。

**第二步：确认被访问地址是否落在报告所说的内存块内。**

```text
0x606000000020 is located 0 bytes inside of 64-byte region
[0x606000000020,0x606000000060)
```

这段信息说明：

- 动态数组的地址区间是左闭右开的 `[0x606000000020, 0x606000000060)`。
- 结束地址减去开始地址是十六进制 `0x40`，也就是十进制 64 字节，与构造时申请的大小一致。
- 错误地址距离区域起点 `0 bytes`，说明访问的是数组第 0 个字节。

因此，这不是数组下标超过 64 导致的普通越界，而是数组第 0 个字节原本合法、后来整块内存被释放，程序又继续写它。错误分类为 use-after-free 是合理的。

**第三步：查看 `freed by`，找到资源在哪里结束生命周期。**

```text
freed by thread T0 here:
    #0 operator delete[](void*) asan_new_delete.cc:168
    #1 ResourceBuffer::~ResourceBuffer() main.cpp:24
    #2 run_use_after_free_path() main.cpp:112
    #3 main main.cpp:137
```

这组调用栈描述释放过程：

1. `run_use_after_free_path()` 执行到 `main.cpp:112` 附近时，内部作用域结束，局部变量 `owner` 开始析构。
2. `ResourceBuffer::~ResourceBuffer()` 在 `main.cpp:24` 调用 `delete[] data_`。
3. 最终进入 ASan 拦截的 `operator delete[]`，将整块动态数组标记为已释放。

报告中 `#0` 的 `asan_new_delete.cc` 是 ASan 运行时内部实现，不是业务代码的根因。真正需要回到源码检查的是第一条属于自己项目的调用栈，也就是 `ResourceBuffer::~ResourceBuffer()`，然后继续看是谁触发了这个析构。

需要注意，开启 `-O1` 后编译器可能内联函数，同一个源码行也可能同时被标记为对象创建位置或作用域退出位置。行号的作用是缩小范围，最终仍要结合花括号、对象作用域和代码语义判断。

**第四步：查看 `previously allocated by`，找到资源最初从哪里获得。**

```text
previously allocated by thread T0 here:
    #0 operator new[](unsigned long) asan_new_delete.cc:107
    #1 ResourceBuffer::ResourceBuffer(unsigned long) main.cpp:12
    #2 run_use_after_free_path() main.cpp:112
    #3 main main.cpp:137
```

这组调用栈说明资源最初由 `ResourceBuffer` 构造函数中的 `new std::byte[size]` 分配，创建者是 `run_use_after_free_path()` 内部的局部对象 `owner`。至此形成了完整证据链：

```text
main.cpp:112  构造 owner，申请 64 字节
      ↓
observer 保存 owner.data()，但没有取得所有权
      ↓
内部作用域结束，owner 析构并释放 64 字节
      ↓
main.cpp:119  observer[0] 写入已释放区域
      ↓
ASan 报告 heap-use-after-free
```

**第五步：用 `SUMMARY` 快速复核结论。**

```text
SUMMARY: AddressSanitizer: heap-use-after-free
/home/mahiro/learn_project/main.cpp:119
in run_use_after_free_path()
```

`SUMMARY` 是前面证据的压缩结论，适合在较长日志中快速搜索错误类型和首要位置。不过它没有包含分配与释放链路，不能只看这一行就开始修改代码。

**第六步：理解 Shadow Bytes，但不要一开始就陷入地址换算。**

ASan 为应用内存维护一块对应的**影子内存（shadow memory）**，用较少的标记字节记录一段应用内存当前是否允许访问。报告明确说明一个 shadow byte 对应 8 个应用字节：

```text
Shadow byte legend (one shadow byte represents 8 application bytes):
  Addressable:           00
  Heap left redzone:       fa
  Freed heap region:       fd

=>0x0c0c7fff8000: fa fa fa fa[fd]fd fd fd fd fd fd fd fa fa fa fa
```

本例需要看懂三个标记：

- `00`：对应的 8 个应用字节可以访问。
- `fd`：对应区域原来属于堆内存，但现在已经释放。
- `fa`：堆对象周围的红区（redzone），用于检测越界访问，本来就不允许业务代码访问。

方括号 `[fd]` 标出错误地址对应的 shadow byte。连续 8 个 `fd` 对应 `8 × 8 = 64` 字节，正好覆盖被释放的整个动态数组。左右两侧的 `fa` 是 ASan 放置的红区。这再次证明目标地址位于一块已经释放的 64 字节堆区域中。

其他 shadow 标记只需在遇到对应问题时再查。例如 `f8` 表示作用域结束后仍访问栈变量，`f5` 表示函数返回后仍访问其栈空间；本例的核心标记只有 `fd`。

**最后一行 `ABORTING` 表示什么。**

```text
==4339==ABORTING
```

ASan 已经捕获错误并终止进程，所以 `uaf` 模式返回非零退出状态是预期现象。这不是测试工具自身崩溃，也不能被代码中的 `catch (const std::exception&)` 捕获。ASan 报告的是 C++ 未定义行为，而不是程序主动抛出的 C++ 异常。

综合起来，阅读此类 ASan 报告最实用的固定顺序是：

1. 看错误类型、读写方向、访问大小和线程。
2. 看第一组调用栈的 `#0`，定位非法访问语句。
3. 看地址区间和偏移，判断是越界还是有效区域释放后使用。
4. 看 `freed by`，定位资源生命周期在哪里结束。
5. 看 `previously allocated by`，定位资源从哪里创建。
6. 把三处位置按时间顺序连成所有权与生命周期链路。
7. 最后用 `SUMMARY` 和 Shadow Bytes 复核结论。

若未出现 ASan 报告，先确认程序确实使用 `-fsanitize=address` 重新编译，并确认运行的是新生成的可执行文件。不要根据一次未崩溃的普通构建判断该访问合法，因为 use-after-free 属于未定义行为。

### 10.5 故障修复与验收检查

修复方案取决于实际所有权需求：

- 如果访问必须发生在资源销毁前，就缩短观察者的使用范围，让访问留在拥有者作用域内。
- 如果任务需要带着资源离开当前作用域，就转移拥有对象本身，而不是只复制其内部地址。
- 如果多个长期任务确实需要共同维持资源，应在阶段 1-2 学习共享所有权类型后再选择共享方案，不能用多个裸指针冒充共享所有权。

本节可以用下面的清单验收：

- 能区分作用域、存储期、对象生命周期和资源生命周期。
- 能解释正常返回、提前返回和异常传播时为何都会析构已构造的局部对象。
- 能说明 RAII 的构造获取、析构释放和所有权不变量。
- 能区分唯一拥有者与非拥有型裸指针观察者。
- 能解释 Rule of Zero 为什么优先，以及 Rule of Five 要检查哪些操作。
- 能区分悬空指针、野指针、use-after-free、重复释放和内存泄漏。
- 能画出 `ResourceBuffer` 从 `source` 移动到 `target`，再由 `target` 释放资源的所有权变化。
- 能从 ASan 报告中指出非法访问点、释放点和分配点。
- 修复故障后，安全、提前返回、异常和移动路径均不出现 ASan 错误。
