---
title: '[嵌入式AI-C++工程] 拷贝、移动与cv-Mat内存语义'
published: 2026-09-24T08:02:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍拷贝、移动与cv-Mat内存语义的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-3 拷贝、移动与`cv::Mat`内存语义

本节讨论两类容易混在一起的问题：C++ 对象在传参和进入容器时，是复制还是移动；OpenCV 计算机视觉库中的 `cv::Mat` 被复制时，像素数据是否真的产生了另一份。

对象生命周期和资源获取即初始化（Resource Acquisition Is Initialization，RAII）已在阶段 1-1 第 1～5 节介绍，`std::move` 也在阶段 1-1 第 7 节和阶段 1-2 第 1 节出现过。本节不再重复资源管理基础，而是把复制、移动和图像缓冲区共享之间的关系讲清楚。

## 1 C++左值、右值、复制构造与移动构造

### 1.1 左值与右值的实用判断

在本节需要掌握的范围内，可以先使用下面的判断方法：

- **左值（lvalue）**：有明确身份、之后还能通过名字继续访问的对象。例如变量 `frame`。
- **右值（rvalue）**：通常表示临时值，或者明确表示“允许从这里取走资源”的值。例如函数返回的临时对象，以及 `std::move(frame)` 的结果。

```cpp
Frame frame;              // frame 是有名字的对象，因此表达式 frame 是左值
consume(frame);           // 传入左值
consume(std::move(frame)); // std::move(frame) 是右值表达式
consume(Frame{});         // Frame{} 创建临时对象，也是右值
```

需要注意的是，“对象”和“表达式的值类别”不是一回事。`frame` 这个对象没有被 `std::move` 变成另一种对象；只是表达式 `std::move(frame)` 允许后续代码选择移动操作。

工程中最实用的问题不是背诵全部值类别，而是看到调用时能回答：

1. 这个对象后面还需要保留原内容吗？
2. 如果不需要，是否可以用 `std::move` 表达“允许转移其内部资源”？
3. 接收方是否真的提供了移动构造或移动赋值操作？

### 1.2 复制构造与移动构造的区别

使用一个已有对象创建同类型的新对象时，会进入复制构造或移动构造：

```cpp
Frame copied{source};            // source 是左值，调用复制构造
Frame moved{std::move(source)};  // 允许调用移动构造
```

两种构造函数的典型声明如下：

```cpp
Frame(const Frame& other); // 复制构造函数
Frame(Frame&& other);      // 移动构造函数
```

这里每一部分的含义是：

- `Frame(...)`：构造一个新的 `Frame` 对象。
- `const Frame& other`：以只读引用观察源对象，不能取走或修改其资源，适合复制。
- `Frame&& other`：右值引用参数，可以接收允许被移动的 `Frame`，适合转移其资源。

**复制构造**应让新旧两个对象都能独立满足各自的使用要求。若类拥有一块独占动态内存，复制通常需要重新分配内存并复制内容。

**移动构造**通常把源对象持有的指针、容器或句柄转给新对象，避免复制大块数据。转移后，源对象仍然必须是可以析构、可以重新赋值的有效对象，但其原内容通常不能再依赖。

如果成员本身已经正确实现复制和移动，例如 `std::string`、`std::vector` 和智能指针，应优先组合这些类型并遵守阶段 1-1 第 6 节的零法则。只有类亲自管理特殊资源时，才需要谨慎手写这些特殊成员函数。

### 1.3 `std::move`的作用与移动后对象状态

`std::move` 定义在 `<utility>` 头文件中。它不复制数据、不搬运内存，也不保证一定调用移动构造；它只是把表达式转换成可以匹配右值引用的形式。

因此，下列过程要分成两步理解：

```cpp
Frame target{std::move(source)};
```

1. `std::move(source)` 表示允许从 `source` 转移资源。
2. `Frame` 的移动构造函数决定具体如何转移。

如果类型没有可用的移动构造函数，某些表达式仍可能退回复制。反过来，也不要在仍需保留原内容时随意写 `std::move`。

移动后的对象处于**有效但内容未指定**的状态。这里“有效”表示可以安全析构，也可以重新赋值；“内容未指定”表示不能假定字符串一定为空、指针一定为 `nullptr`，除非该类型的接口明确作出这种保证。

例如，移动后的 `source` 可以安全析构；如果 `Frame` 提供赋值操作，也可以给它重新赋值后再使用。但在没有类型保证时，不应继续依赖 `source` 原来的帧名、缓冲区或句柄。

## 2 函数和容器传递对象时的复制与移动

### 2.1 按值传递、左值传入与右值传入

按值参数会在函数内部创建一个新的参数对象：

```cpp
void process(Frame frame);
```

调用方式会影响这个新对象怎样构造：

- `process(source)`：`source` 是左值，通常复制构造参数。
- `process(std::move(source))`：允许移动构造参数。
- `process(Frame{})`：传入临时对象，编译器还可能直接在参数位置构造对象，省略复制或移动。

是否按值传递不能只看“复制贵不贵”，还要看函数是否需要取得一份自己的对象：

- 只在调用期间读取对象：通常使用 `const Frame&`，避免创建新对象。
- 需要修改调用者的同一个对象：使用 `Frame&`。
- 函数要保存或接管一份对象：按值传递常常更直接，再把参数移动到成员或容器中。

编译器的复制省略（copy elision）可能让某些临时对象根本不发生复制或移动。因此，日志 Demo 用来观察指定调用路径，不应把某一次编译器输出误认为所有表达式都必然产生相同次数。

### 2.2 容器插入和扩容产生的复制与移动

`std::vector<Frame>` 表示“元素类型为 `Frame` 的动态数组”。它的元素存放在一段连续内存中，容量不够时会申请更大的内存，并把已有元素迁移过去。

本节会用到两个成员函数：

- `reserve(2)`：预留至少能放 2 个元素的容量，但不创建元素。它用于避免接下来两次插入触发扩容，使日志只验证插入本身。
- `push_back(value)`：在末尾构造一个元素。传入左值时复制，传入右值时优先移动。

若没有提前预留容量，扩容时已有元素也可能被移动或复制。标准容器通常更愿意移动一个移动构造标记为 `noexcept` 的类型，因为这表示移动不会抛出异常；若移动可能抛异常而复制可用，容器为了维持异常安全，可能选择复制。

队列、任务池和异步流水线的判断原则相同：不要只看调用点写了 `std::move`，还要沿着函数参数、容器插入和任务保存过程检查，最终存入的是同一个共享对象、一份复制，还是被移动后的新对象。

## 3 `cv::Mat`对象头、像素缓冲区与浅拷贝

### 3.1 `cv::Mat`对象头保存的信息

OpenCV（Open Source Computer Vision Library）是常用的开源计算机视觉库。`cv::Mat` 是它在 C++ 中表示二维图像和多维数组的核心类型。

理解 `cv::Mat` 时要把两部分分开：

1. **对象头**：尺寸、元素类型、行跨度、数据地址、引用计数相关信息等描述数据的字段。
2. **像素缓冲区**：真正保存像素字节的内存。

一个 `cv::Mat` 对象本身通常不等于整块图像数据。复制对象头很轻量，而复制数百万个像素可能很昂贵，所以 OpenCV 默认允许多个 `cv::Mat` 对象头共享同一块像素缓冲区。

### 3.2 浅拷贝、引用计数与像素共享

下面这行代码是**浅拷贝（shallow copy）**：

```cpp
cv::Mat copied = original;
```

它创建新的 `cv::Mat` 对象头，但不复制像素缓冲区。`copied` 和 `original` 指向相同像素；通过其中一个对象修改像素，另一个对象读取到的内容也会变化。

OpenCV 使用引用计数记录有多少个 `cv::Mat` 对象头正在共享由 OpenCV 管理的缓冲区。浅拷贝时计数增加；对象释放时计数减少；最后一个引用离开后，缓冲区才被释放。官方文档明确说明普通矩阵赋值是常数时间操作，只共享数据并增加引用计数，详见 [`cv::Mat` 类参考](https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html)。

引用计数解决的是“缓冲区何时释放”，不是“多个线程能否同时修改像素”。它不会自动复制图像，也不会给像素访问加锁。

### 3.3 共享像素缓冲区的生命周期与并发修改风险

局部 `cv::Mat` 对象离开作用域时，不代表共享像素一定立即释放。只要另一个 `cv::Mat` 对象头仍持有这块由 OpenCV 管理的缓冲区，引用计数就能延长它的生命周期。

但要区分两种情况：

- 由 `cv::Mat` 自己分配并管理的缓冲区：浅拷贝通常可以依靠引用计数维持生命周期。
- 用外部地址构造的 `cv::Mat`：对象头可能只借用这块内存，外部所有者仍负责保证地址有效。外部缓冲区先释放或被采集设备重新使用后，`cv::Mat` 仍可能指向失效或已改变的数据。

异步代码还有数据竞争风险。生产线程和消费线程共享同一缓冲区时，只要至少一方写像素，又没有正确同步，程序就可能读到撕裂数据或形成 C++ 数据竞争。引用计数是生命周期机制，不是线程同步机制。

## 4 `cv::Mat`深拷贝、ROI与异步传递

### 4.1 `clone()`与`copyTo()`的深拷贝语义

需要独立像素缓冲区时，应显式执行**深拷贝（deep copy）**。

`clone()` 的基本语法是：

```cpp
cv::Mat destination = source.clone();
```

- 功能：创建尺寸、类型和像素内容相同的新矩阵。
- 返回值：一个拥有独立像素数据的 `cv::Mat`。
- 适用情况：需要直接得到一个新对象时，写法最简洁。

`copyTo()` 的基本语法是：

```cpp
source.copyTo(destination);
```

- 功能：把源矩阵像素复制到目标矩阵。
- 输出：通过参数 `destination` 接收结果；尺寸或类型不匹配时通常会重新分配。
- 适用情况：目标对象已经存在，或者需要使用带掩码的重载时。

两者都能复制像素，但接口形式不同。官方 [`cv::Mat` 文档](https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html) 将 `clone()` 定义为复制数组及其底层数据，并说明 `copyTo()` 会把矩阵数据复制到目标矩阵。

深拷贝会消耗与有效图像数据规模相关的时间和内存带宽。不要因为“异步”两个字就无条件复制，也不要为省一次复制而接受不清楚的数据所有权。

### 4.2 ROI与原图共享像素数据

感兴趣区域（Region of Interest，ROI）表示图像中需要处理的一个矩形子区域。常用写法是：

```cpp
cv::Rect area(x, y, width, height);
cv::Mat roi = image(area);
```

`cv::Rect` 的四个构造参数依次表示：

- `x`：矩形左上角在原图中的列坐标。
- `y`：矩形左上角在原图中的行坐标。
- `width`：区域宽度，单位是像素列。
- `height`：区域高度，单位是像素行。

`image(area)` 不会自动复制矩形中的像素，只创建描述该区域的新对象头。因此，修改 `roi` 会修改原图对应位置；原图缓冲区未失效前，ROI 才能安全访问。若需要独立保存区域，应写：

```cpp
cv::Mat independent_roi = image(area).clone();
```

OpenCV 官方对 ROI 构造函数的说明同样指出：它只创建指向原数据或子数组的对象头，并增加引用计数；若要独立副本，应使用 `clone()`，见 [`cv::Mat` ROI 构造说明](https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html)。

### 4.3 异步传递图像时的浅拷贝与深拷贝选择

把 `cv::Mat` 放进异步队列前，可以按下面的顺序判断：

1. **缓冲区由谁拥有？** 若只是包装相机、解码器或内存池提供的外部地址，先确认外部缓冲区何时被归还或复用。
2. **生产者入队后还会写吗？** 如果会，浅拷贝会让消费者看到变化。
3. **消费者是否只读？** 多个消费者只读同一份稳定数据时，浅拷贝通常可以减少内存带宽。
4. **队列中的图像要保存多久？** 保存时间超过外部缓冲区有效期时，需要复制到自己管理的内存，或把外部所有权一同安全传递。
5. **是否允许消费者看到同一时刻的固定快照？** 若需要固定快照，在生产者交付前完成 `clone()` 或等价深拷贝。

常见选择如下：

- OpenCV 自管缓冲区，入队后所有参与者只读：可以浅拷贝 `cv::Mat` 对象头。
- 生产者会复用或覆盖缓冲区：入队前深拷贝，或者设计明确的缓冲池所有权转移。
- 消费者需要修改但不能影响其他模块：消费者先 `clone()`，再修改自己的副本。
- 高帧率系统复制成本过高：不要偷偷共享可写内存，应使用缓冲池、只读约定和明确的归还时机重新设计数据流。

## 5 `cv::Mat`的`step`、连续性与内存地址含义

### 5.1 `rows`、`cols`、`elemSize()`与`step`

对普通二维图像，可以这样理解几个常用成员：

- `rows`：图像行数，即高度。
- `cols`：图像列数，即宽度。
- `elemSize()`：一个像素元素占用的总字节数，包含全部通道。例如 `CV_8UC3` 的结果通常是 3。
- `step`：相邻两行起始地址之间相差的字节数，也叫行跨度或行步长。

一行真正参与当前矩阵运算的像素字节数通常是：

```text
cols * elemSize()
```

而下一行的开始地址是：

```text
data + row * step
```

因此，`step` 的单位是**字节**，不是虚拟宽度，也不是虚拟高度。由于行尾对齐填充或 ROI 仍沿用原图行跨度，`step` 可能大于 `cols * elemSize()`。官方文档也把 `step` 定义为每一行占用的字节数，并明确它包含行尾填充，见 [`cv::Mat` 构造参数说明](https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html)。

### 5.2 `isContinuous()`与逐行访问

`isContinuous()` 返回布尔值，用于判断当前矩阵相邻行之间是否没有空隙。对于二维矩阵，可用下面的关系帮助理解：

```text
rows == 1，或者 step == cols * elemSize()
```

若返回 `true`，可以在类型和边界正确的前提下，把全部像素看作一段连续元素处理。若返回 `false`，就必须逐行取得行首地址，并只访问每行有效的像素部分，不能直接假定 `rows * cols * elemSize()` 个字节紧挨在一起。

完整原图通常连续，但从原图中截取的窄 ROI 往往不连续：ROI 每行只使用中间几列，下一行的起点仍按原图的 `step` 前进。OpenCV 官方对 [`isContinuous()`](https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html) 的说明也是“行尾是否存在间隙”，并建议根据连续性选择单段或逐行处理。

### 5.3 虚拟地址连续与物理内存连续的区别

`cv::Mat::isContinuous()` 讨论的是程序能够看到的**虚拟地址布局**：当前矩阵的上一行有效数据结束后，下一行是否紧接着开始。

它不能证明底层物理内存页连续。现代操作系统通过页表把连续的虚拟地址映射到可能分散的物理页。普通 CPU 代码访问 `cv::Mat` 时通常只需要关心虚拟地址和行跨度；涉及直接内存访问（Direct Memory Access，DMA）、相机驱动或硬件加速器时，物理连续性、缓存一致性和设备地址需要由对应的驱动或内存分配接口保证。

所以不能做出下面的推断：

```text
mat.isContinuous() == true
    不等于
这块内存可以直接当作物理连续 DMA 缓冲区
```

## 6 拷贝、移动与`cv::Mat`内存语义验证Demo

### 6.1 `Frame`复制与移动次数验证

这个小 Demo 只回答一个问题：同一个 `Frame` 以左值和右值放进 `std::vector` 时，分别调用复制构造还是移动构造。

代码使用的知识已经在前文说明：

- `std::vector<Frame>` 是元素类型为 `Frame` 的动态数组。
- `reserve(2)` 只预留两个元素的容量，用于排除扩容迁移的干扰。
- `push_back(source)` 接收左值，复制一个元素。
- `push_back(std::move(source))` 接收右值，移动一个元素。
- `Frame(Frame&& other) noexcept` 是不会抛异常的移动构造函数。
- 构造函数冒号后的成员初始化列表，会在进入函数体前直接初始化成员。

依赖：C++17 标准库，不需要 OpenCV。输入：程序内部创建的一个 `Frame`。输出：构造、复制、移动和析构日志。

```cpp
// frame_copy_move_demo.cpp
#include <iostream>
#include <string>
#include <utility>
#include <vector>

class Frame {
public:
    Frame() : name_("frame-0") {
        std::cout << "construct Frame\n";
    }

    // 复制构造：为新对象复制一份字符串内容，源对象保持不变。
    Frame(const Frame& other) : name_(other.name_) {
        std::cout << "copy Frame\n";
    }

    // 移动构造：把字符串内部资源交给新对象，避免复制字符串内容。
    // noexcept 告诉容器，这个移动过程不会抛出异常。
    Frame(Frame&& other) noexcept : name_(std::move(other.name_)) {
        std::cout << "move Frame\n";
    }

    ~Frame() {
        std::cout << "destroy Frame\n";
    }

private:
    std::string name_;
};

int main() {
    std::vector<Frame> frames;

    // 预留两个元素的位置，避免第二次插入时扩容并迁移第一个元素。
    frames.reserve(2);

    Frame source;

    // source 是左值：vector 内的新元素通过复制构造产生。
    frames.push_back(source);

    // 明确表示以后不再依赖 source 的原内容：新元素通过移动构造产生。
    frames.push_back(std::move(source));

    std::cout << "stored frames: " << frames.size() << '\n';
}
```

Linux 编译和运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic frame_copy_move_demo.cpp -o frame_copy_move_demo
./frame_copy_move_demo
```

关键输出应包含：

```text
construct Frame
copy Frame
move Frame
stored frames: 2
```

析构日志会出现三次，因为最终有 `source` 和容器中的两个元素。验收时重点检查复制和移动各出现一次。然后可以删除 `reserve(2)` 再运行，观察容器扩容是否使日志增加；这只是补充验证，不改变 Demo 的主流程。

### 6.2 `cv::Mat`浅拷贝与`clone()`隔离验证

这个小 Demo 只验证：普通赋值共享像素，而 `clone()` 产生独立像素。

代码中新语法和 API 的含义如下：

- `cv::Mat(2, 2, CV_8UC1, cv::Scalar(10))`：创建 2 行、2 列的矩阵，并把元素初始化为 10。
- `CV_8UC1`：每个通道是 8 位无符号整数（8-bit unsigned），通道数为 1。
- `at<unsigned char>(row, col)`：按“行、列”访问一个单通道 8 位无符号元素；尖括号中的 `unsigned char` 必须与矩阵元素类型匹配。
- `static_cast<int>(value)`：把 8 位整数转成普通整数再输出，避免 `std::cout` 把它当字符显示。
- `clone()`：复制矩阵对象描述和底层像素，返回独立矩阵。

依赖：OpenCV 的 Core 模块。输入：程序生成的 2×2 单通道矩阵。输出：修改前后的指定像素值。

```cpp
// mat_copy_demo.cpp
#include <opencv2/core.hpp>

#include <iostream>

int main() {
    // 创建 2×2 单通道图像，四个像素的初始值都是 10。
    cv::Mat original(2, 2, CV_8UC1, cv::Scalar(10));

    // 浅拷贝只复制 Mat 对象头，shallow 与 original 共享像素缓冲区。
    cv::Mat shallow = original;

    // clone() 复制像素，deep 拥有独立缓冲区。
    cv::Mat deep = original.clone();

    // 通过浅拷贝修改左上角像素，original 的同一位置也会变成 99。
    shallow.at<unsigned char>(0, 0) = 99;

    std::cout << "original(0,0): "
              << static_cast<int>(original.at<unsigned char>(0, 0)) << '\n';
    std::cout << "shallow(0,0): "
              << static_cast<int>(shallow.at<unsigned char>(0, 0)) << '\n';
    std::cout << "deep(0,0): "
              << static_cast<int>(deep.at<unsigned char>(0, 0)) << '\n';

    // 修改 deep 的另一个像素，不会影响 original。
    deep.at<unsigned char>(0, 1) = 77;
    std::cout << "original(0,1): "
              << static_cast<int>(original.at<unsigned char>(0, 1)) << '\n';
    std::cout << "deep(0,1): "
              << static_cast<int>(deep.at<unsigned char>(0, 1)) << '\n';
}
```

Ubuntu/Debian 安装依赖、编译和运行：

```bash
sudo apt install libopencv-dev pkg-config
g++ -std=c++17 -Wall -Wextra -pedantic mat_copy_demo.cpp \
    $(pkg-config --cflags --libs opencv4) -o mat_copy_demo
./mat_copy_demo
```

`pkg-config --cflags --libs opencv4` 会输出 OpenCV 头文件目录和链接参数，再由 shell 放入 `g++` 命令。

预期输出：

```text
original(0,0): 99
shallow(0,0): 99
deep(0,0): 10
original(0,1): 10
deep(0,1): 77
```

前三行证明浅拷贝共享、深拷贝隔离；后两行从反方向证明修改深拷贝不会影响原图。

### 6.3 ROI、`step`与`isContinuous()`验证

这个小 Demo 只验证：从连续原图中截取一个较窄的 ROI 后，ROI 仍沿用原图行跨度，因此可能不连续。

代码所用接口已在第 4.2 和第 5 节解释。补充两点：

- `CV_8UC3` 表示每个通道为 8 位无符号整数、每个像素有 3 个通道。
- `isContinuous()` 输出到 `std::cout` 时，默认用 `1` 表示 `true`，用 `0` 表示 `false`。

依赖：OpenCV 的 Core 模块。输入：程序生成的 4×6 三通道矩阵和固定 ROI。输出：原图与 ROI 的尺寸、每像素字节数、有效行字节数、`step` 和连续性。

```cpp
// mat_roi_step_demo.cpp
#include <opencv2/core.hpp>

#include <iostream>

int main() {
    // 4 行、6 列、3 通道；完整矩阵由 OpenCV 分配，通常是连续的。
    cv::Mat image(4, 6, CV_8UC3, cv::Scalar(0, 0, 0));

    // 从坐标 (1, 1) 开始，截取宽 3、高 2 的矩形区域。
    cv::Rect area(1, 1, 3, 2);
    cv::Mat roi = image(area);

    std::cout << "image rows: " << image.rows
              << ", cols: " << image.cols
              << ", elemSize: " << image.elemSize()
              << ", active row bytes: " << image.cols * image.elemSize()
              << ", step: " << image.step
              << ", continuous: " << image.isContinuous() << '\n';

    // ROI 每行只有 3×3=9 个有效字节，但下一行仍按原图的 step 前进。
    std::cout << "roi rows: " << roi.rows
              << ", cols: " << roi.cols
              << ", elemSize: " << roi.elemSize()
              << ", active row bytes: " << roi.cols * roi.elemSize()
              << ", step: " << roi.step
              << ", continuous: " << roi.isContinuous() << '\n';
}
```

编译方式与 6.2 相同，只需替换源文件名：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic mat_roi_step_demo.cpp \
    $(pkg-config --cflags --libs opencv4) -o mat_roi_step_demo
./mat_roi_step_demo
```

在常见 OpenCV 实现中，关键结果应接近：

```text
image rows: 4, cols: 6, elemSize: 3, active row bytes: 18, step: 18, continuous: 1
roi rows: 2, cols: 3, elemSize: 3, active row bytes: 9, step: 18, continuous: 0
```

这里 ROI 的 `cols` 是 3，不能因为 `step` 是 18 就把 ROI 宽度理解成 6。`step` 只说明从当前行起点前进多少字节才能到下一行起点。

### 6.4 Demo结果与异步图像传递验收

完成三个 Demo 后，应能独立回答并验证以下问题：

1. `push_back(source)` 为什么复制，而 `push_back(std::move(source))` 为什么可以移动？
2. `std::move` 自己是否移动了对象内部数据？
3. `cv::Mat copied = original` 是否复制像素？修改 `copied` 为什么影响 `original`？
4. `clone()` 为什么能隔离修改？它付出的主要成本是什么？
5. ROI 的 `step` 为什么可能大于 `cols * elemSize()`？
6. `isContinuous()` 为真能否证明物理内存连续？
7. 相机缓冲区会在下一帧被复用时，异步队列里只放一个浅拷贝 `cv::Mat` 是否安全？

第 7 个问题的直接答案是：通常不安全。浅拷贝只延长 OpenCV 自管缓冲区的引用关系，不能阻止外部相机缓冲区被驱动或采集模块复用。应在缓冲区归还前完成处理、显式深拷贝，或者把缓冲区所有权和归还时机一起纳入队列协议。
