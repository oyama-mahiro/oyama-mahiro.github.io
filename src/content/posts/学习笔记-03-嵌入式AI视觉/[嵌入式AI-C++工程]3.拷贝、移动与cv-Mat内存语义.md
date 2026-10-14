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

在嵌入式 AI 与图像处理工程中，数据吞吐量极大、内存带宽紧张，性能瓶颈往往出在不经意的“隐式内存拷贝”上。本篇核心解决两个高度关联但常被混淆的技术点：
1. **C++ 语言层**：对象在传参、赋值、放入标准容器时，究竟触发了拷贝（深拷贝开销）还是移动（资源所有权转移）？
2. **OpenCV 库层**：`cv::Mat` 在传递与赋值时，底层数兆字节的图像像素到底有没有被复制？

搞清楚底层内存与对象语义，是写出低时延、零拷贝图像处理管线的基石。

---

## 1 C++左值、右值、复制构造与移动构造

### 1.1 左值与右值的实用判断

工程排查时，不需要死记语法标准中细分的 prvalue、xvalue 等复杂概念，掌握最直观的工程判断准则即可：

- **左值（lvalue）**：**有持久身份、有明确变量名、可以取地址**的对象。生命周期跨越当前语句，后续代码还能通过名字继续访问它。例如具名变量 `frame`。
- **右值（rvalue）**：**没有持久身份的临时对象**，或者**被明确标记为“可以被剥夺资源”的表达式**。它们通常在当前语句结束后就立即消亡。例如字面量、函数返回的临时值，以及通过 `std::move(frame)` 强转后的表达式。

```cpp
Frame frame;               // frame 是具名变量 -> 表达式 frame 是左值
consume(frame);            // 传入左值：consume 必须拷贝一份，不能破坏外部的 frame
consume(std::move(frame)); // std::move 将其转为右值表达式：允许 consume 掏空 frame 的资源
consume(Frame{});          // Frame{} 是纯临时对象 -> 右值，用完即弃
```

> **核心认知**：
> `std::move(frame)` **并没有改变 `frame` 这个变量本身的对象类型**，它只是在表达式层面上做了一次右值强制转换，给编译器开辟了一条“可以调用移动语义”的语法通道。

在阅读或编写代码时，养成自问三连的习惯：
1. 这个对象后续逻辑还要继续使用吗？
2. 如果不需要了，是否可以通过 `std::move` 转移其内部的大块堆内存或句柄？
3. 接收方的类是否真正实现了移动构造/移动赋值？

---

### 1.2 复制构造与移动构造的区别

当用一个现有对象去初始化一个同类型的新对象时，编译器会在两者之间抉择：

```cpp
Frame copied{source};           // source 是左值 -> 触发复制构造（Copy Constructor）
Frame moved{std::move(source)}; // std::move(source) 是右值 -> 触发移动构造（Move Constructor）
```

它们的签名与底层语义对比：

```cpp
Frame(const Frame& other); // 复制构造：只读引用，不可篡改原对象
Frame(Frame&& other);      // 移动构造：右值引用，被授予“剥夺原对象资源”的权限
```

| 维度 | 复制构造（Copy） | 移动构造（Move） |
| :--- | :--- | :--- |
| **参数类型** | `const Frame&`（常量左值引用） | `Frame&&`（右值引用） |
| **内存操作** | 重新向系统申请一块新的堆内存，并逐字节把内容完整复制过去。 | 仅进行指针与句柄的浅层复制（如将新指针指向旧内存），并将原对象的指针置空。 |
| **运行开销** | 昂贵（随数据量线性增长 $O(N)$，消耗 CPU 算力与内存带宽）。 | 极低（常数时间复杂度 $O(1)$，通常仅为几次指针赋值）。 |
| **源对象状态** | 原封不动，保持完整有效。 | 资源被掏空，原对象仍处于有效状态但已无实际内容。 |

如果类内部成员都是符合现代 C++ 规范的类型（如 `std::vector`、`std::string`、`std::unique_ptr`），应当严格遵循**零法则（Rule of Zero）**，让编译器自动生成移动和拷贝操作；只有在类自身直接持有原始指针（如 `void* dma_buffer`、OS 文件描述符）时，才需要手动手写这套逻辑。

---

### 1.3 `std::move`的作用与移动后对象状态

`std::move` 内部并不搬运任何内存字节，它的本质仅仅是一个**无条件的强制类型转换**（等价于 `static_cast<T&&>(var)`）。

```cpp
Frame target{std::move(source)};
```

执行这行代码的实质分工：
1. `std::move(source)`：仅仅负责在语法上将 `source` 标记为右值。
2. `Frame` 类的移动构造函数：真正执行把 `source` 的内部缓冲区指针赋值给 `target`，并把 `source` 内部指针设为 `nullptr` 的操作。

> **陷阱警告**：如果一个类只写了复制构造函数，而没有声明移动构造函数，即使写了 `std::move(source)`，编译器也会因为找不到匹配的 `Frame(Frame&&)` 而**安全回退（Fallback）到复制构造函数**，导致仍然发生昂贵的全量深拷贝。

**移动后源对象处于什么状态？**
标准规定：移动后的对象处于**“有效但未指定（valid but unspecified）”**的状态。
- **有效**：它的析构函数能正常运行，不会 double free；你也可以对它重新赋值。
- **未指定**：不能假设它内部还剩什么值（不能假定其指针必然为 null，也不能假定字符串长度必然为 0）。因此，被 `std::move` 掏空的对象，**后续逻辑绝不能再读取其原有数据**。

---

## 2 函数和容器传递对象时的复制与移动

### 2.1 按值传递、左值传入与右值传入

当函数参数声明为按值传递时：

```cpp
void process(Frame frame);
```

调用时实际发生的事情由传入实参的值类别决定：

```
实参为左值：process(source)            ---> 触发 Frame 复制构造（深拷贝）
实参为右值：process(std::move(source))  ---> 触发 Frame 移动构造（廉价转移）
实参为临时值：process(Frame{})          ---> 触发移动构造，或被编译器直接省略构造（Copy Elision）
```

**工程接口设计最佳实践**：
- **纯只读观察**：统一使用 `const Frame&`，彻底规避任何对象构造与拷贝开销。
- **原地修改外部对象**：使用非 const 引用 `Frame&`。
- **函数内部必须接管/沉降一份独立对象**（例如需要存进内部成员或异步队列）：建议直接**按值传递**（`void sink(Frame f)`），内部再通过 `std::move(f)` 存入。这样调用者传入左值时自然拷贝，传入右值时自然移动，兼顾效率与接口简洁性。

---

### 2.2 容器插入和扩容产生的复制与移动

将自定义对象放入 `std::vector<Frame>` 时，涉及两处关键行为：

1. **显式插入阶段**：
   - `vec.push_back(frame)`：传入左值，调用复制构造。
   - `vec.push_back(std::move(frame))`：传入右值，调用移动构造。
2. **自动扩容阶段**：
   当 `vector` 当前容量（`capacity`）不足时，它会在堆上重新开辟一块更大的连续内存区，并将旧内存中的所有历史元素迁移到新区域。

> **核心细节：`noexcept` 对容器扩容的影响**
> 为了保证强异常安全（Strong Exception Safety），如果新元素在迁移过程中抛出异常，`std::vector` 必须保证旧数据不被损坏。
> - 如果你的类的移动构造函数**没有标记 `noexcept`**，`std::vector` 在扩容迁移时会**放弃移动，退化为全量复制构造**！
> - 因此，**移动构造函数必须显式标注 `noexcept`**：
>   ```cpp
>   Frame(Frame&& other) noexcept;
>   ```

此外，在已知数据量的情况下，务必提前调用 `vec.reserve(N)` 预分配内存，从源头彻底消灭扩容引发的反复数据迁移。

---

## 3 `cv::Mat`对象头、像素缓冲区与浅拷贝

### 3.1 `cv::Mat`对象头保存的信息

在 OpenCV 中，`cv::Mat` 是一个典型的**两段式结构（Header + Data Buffer）**：

```
+------------------------------------------------------+
| cv::Mat 对象头 (Header，栈上分配，约几十字节)           |
| - 尺寸信息: rows, cols, dims                          |
| - 数据布局: step (行步长), elemSize                  |
| - 引用计数指针: int* refcount                        |
| - 像素数据指针: uchar* data ------------------------+ |
+----------------------------------------------------+ |
                                                       |
                                                       v
+------------------------------------------------------+
| 底层像素数据缓冲区 (Data Buffer，堆内存，通常数 MB)    |
| [Pixel 0,0] [Pixel 0,1] ... [Pixel H-1, W-1]         |
+------------------------------------------------------+
```

- **对象头（Header）**：体积小、固定字节数，仅保存矩阵维度、数据类型、步长以及指向实际数据和引用计数块的指针。
- **像素数据缓冲区（Data Buffer）**：实际存储几百万甚至几千万图像像素的连续内存段，体积巨大。

这种分离设计的目的非常明确：**让 `cv::Mat` 作为一个轻量级对象在代码间灵活传递，默认避免大内存拷贝。**

---

### 3.2 浅拷贝、引用计数与像素共享

在 OpenCV 中，**默认的所有赋值操作符和拷贝构造函数，全部都是浅拷贝（Shallow Copy）**：

```cpp
cv::Mat mat_b = mat_a; // 浅拷贝！
```

这行代码做了两件事：
1. 拷贝了一份极轻量的 `mat_b` 对象头；
2. 将 `mat_a` 对应的底层引用计数加 1。

**底层像素缓冲区完全没有被复制！** `mat_a.data` 与 `mat_b.data` 指向完全一致的内存地址。因此：
- 赋值速度极快（常数时间 $O(1)$，纯粹是指针复制与计数器自增）；
- **修改 `mat_b` 的像素值，`mat_a` 看到的内容也会同步发生变化**。

当某个 `cv::Mat` 局部变量离开作用域被析构时，它只会让引用计数减 1。只有当引用计数降至 0 时，底层巨大的像素缓冲区才会被真正 `free` 释放。

---

### 3.3 共享像素缓冲区的生命周期与并发修改风险

这种引用计数机制虽好，但在工程实践中隐藏着两大陷阱：

#### 陷阱一：外部内存封装失效（Dangling Pointer）
如果你是用相机驱动暴露的裸指针直接包装出的 `cv::Mat`：
```cpp
cv::Mat frame(h, w, CV_8UC3, camera_raw_buffer);
```
此时该 `Mat` 的内部引用计数指针为 `nullptr`，**OpenCV 并不负责管理这块外部内存**。如果驱动层在下一帧覆盖或释放了 `camera_raw_buffer`，你手中持有的 `cv::Mat` 就会立即沦为野指针或读到脏数据！

#### 陷阱二：多线程数据竞争（Data Race）
引用计数的增减是原子操作（线程安全），但**像素数据的读写完全没有加锁**。
如果线程 A 正在往 `mat_a` 里写数据，而线程 B 通过浅拷贝持有的 `mat_b` 并发读取，会直接造成数据竞争（Data Race），导致画面撕裂或算法推理出错误结果。

---

## 4 `cv::Mat`深拷贝、ROI与异步传递

### 4.1 `clone()`与`copyTo()`的深拷贝语义

当业务需要修改图像，且不能影响原图时，必须显式触发**深拷贝（Deep Copy）**。

#### 1. `clone()`
```cpp
cv::Mat independent = original.clone();
```
- **语义**：完全开辟一块与原图大小、类型一模一样的新内存，并将所有像素字节复制过去。
- **适用场景**：快速创建一份独立的新图，写法紧凑直观。

#### 2. `copyTo()`
```cpp
original.copyTo(destination);
```
- **语义**：将像素数据复制到预先存在的 `destination` 中。如果 `destination` 已经拥有相同的尺寸和类型，`copyTo()` 会**复用现有内存而不重新申请堆内存**；只有当尺寸或类型不符时才会重新分配。
- **适用场景**：在主循环中反复复用某块预分配好的固定缓冲区，避免高频触发 `malloc/free` 产生内存碎片；或者需要使用 Mask 掩码进行条件拷贝。

---

### 4.2 ROI与原图共享像素数据

在目标检测或裁剪分支中，常使用矩形区域（Region of Interest，ROI）截取子图：

```cpp
cv::Rect roi_box(x, y, width, height);
cv::Mat crop = image(roi_box); // 截取 ROI
```

> **核心本质**：
> **`image(roi_box)` 同样是浅拷贝！**
> 它不会产生任何新的像素拷贝，仅仅是创建了一个新的对象头：
> - 它的 `crop.data` 直接指向原图中 `(x, y)` 对应的那个像素地址；
> - 它的 `crop.step` 继承原图的整行跨度（详见第 5 节）；
> - **修改 `crop` 的像素，原图 `image` 会被直接修改！**

如果后续处理（如送入神经网络预处理做归一化、填充）会原地改写 `crop` 的像素，必须主动做一次深拷贝：
```cpp
cv::Mat safe_crop = image(roi_box).clone();
```

---

### 4.3 异步传递图像时的浅拷贝与深拷贝选择

在嵌入式多线程管线（如：采集线程 -> 推理线程 -> 渲染/推流线程）中，如何安全高效地在队列中传递 `cv::Mat`？

```
                        [决策流程树]
                             |
             底层缓冲区是否由 OpenCV 自身管理？
                    /                 \
                 [是]                 [否 (相机裸指针/DMA映射)]
                  |                     |
         入队后生产端是否立即复用/改写？     必须立即深拷贝入队 (.clone())
               /          \
            [是]          [否]
             |              |
    必须入队前深拷贝    入队后所有消费线程是否全为只读？
                         /          \
                      [是]          [否]
                       |              |
                  安全使用浅拷贝   写线程必须持有独立 .clone() 副本
                  (零拷贝高吞吐)
```

**工程准则总结**：
1. **只读广播场景**：原图由 OpenCV 申请，各后级线程只做特征提取或检测显示，绝不修改图像数据 -> **直接浅拷贝入队**，享受零拷贝性能红利。
2. **流水线覆写场景**：底层是单缓冲区相机采集，下一帧到来时驱动会直接覆盖原地址 -> **必须在回调里第一时间 `.clone()` 出独立副本**，才能安全抛给后续异步队列。

---

## 5 `cv::Mat`的`step`、连续性与内存地址含义

### 5.1 `rows`、`cols`、`elemSize()`与`step`

为了精确操作内存指针，必须透彻理解描述图像维度的四个物理量：

- `rows`：图像的高度（行数 $H$）。
- `cols`：图像的宽度（列数 $W$）。
- `elemSize()`：单个像素占用的**字节总数**（包含所有通道）。例如 `CV_8UC3` 占用 $3 \times 1 = 3$ 字节；`CV_32FC1` 占用 $1 \times 4 = 4$ 字节。
- `step`：**相邻两行的首地址之差（单位：字节）**，也叫行跨度（Row Stride / Pitch）。

一行中实际有效像素的总字节数为：
$$\text{active\_bytes} = \text{cols} \times \text{elemSize()}$$

在内存中定位第 `r` 行、第 `c` 列像素的绝对地址公式为：
$$\text{pixel\_ptr} = \text{data} + r \times \text{step} + c \times \text{elemSize()}$$

> **注意**：
> `step` 的单位永远是**字节（Bytes）**，不是像素个数！
> 在许多系统为了加速内存对齐访问（如 16 字节或 64 字节对齐），或者在 ROI 截图中，`step` 往往**大于** $\text{cols} \times \text{elemSize()}$。

---

### 5.2 `isContinuous()`与逐行访问

`isContinuous()` 返回一个布尔值，用于指示：**这块矩阵的所有行在物理/虚拟内存中是否紧挨着，中间没有任何空隙填充。**

判定准则：
$$\text{isContinuous}() = \text{true} \iff (\text{rows} == 1) \lor (\text{step} == \text{cols} \times \text{elemSize()})$$

```
连续内存 (isContinuous == true):
[--- Row 0 ---][--- Row 1 ---][--- Row 2 ---]   (一行紧接一行，无填充)

非连续内存 (isContinuous == false):
[--- Row 0 ---| Pad ][--- Row 1 ---| Pad ]      (行尾存在对齐填充，或原图 ROI 截取)
```

**对编程的影响**：
- **连续（`isContinuous() == true`）**：可以将整张图视为一个超长的一维数组 `data`，通过一个单重循环 `for (int i = 0; i < rows * cols; ++i)` 进行一次性连续内存读写或 DMA 拷贝，缓存命中率极高。
- **不连续（`isContinuous() == false`）**：**严禁用单重指针一次性越界线性遍历！** 否则会把行尾无效的填充字节读入，或者错位读到原图其他区域。必须使用嵌套循环逐行寻址：
  ```cpp
  for (int r = 0; r < mat.rows; ++r) {
      uchar* row_ptr = mat.ptr<uchar>(r); // 基于 step 准确计算每行的起始地址
      for (int c = 0; c < mat.cols; ++c) {
          // 安全处理第 c 列像素
      }
  }
  ```

---

### 5.3 虚拟地址连续与物理内存连续的区别

在嵌入式 Linux 系统中，必须严格区分 CPU 视角的虚拟地址与外设（NPU/DSP/DMA）视角的物理地址：

- `cv::Mat::isContinuous() == true`：**仅代表在操作系统分配的进程虚拟内存空间中，行与行之间是连续的。**
- 在底层物理内存中，虚拟内存是由 MMU 通过页表（以 4KB 为一页）映射过去的。哪怕虚拟内存连续，这几兆字节的数据在物理 RAM 上大概率也是被打散在离散物理页里的！

```
mat.isContinuous() == true  =/=>  底层物理内存连续！
```

**工程警示**：如果你的边缘设备需要将 `cv::Mat` 直接送给硬件 NPU 做零拷贝推理，**绝对不能直接把 `mat.data` 当成物理连续地址传给驱动的 DMA 控制器**。必须调用专用的连续物理内存分配接口（如 Linux CMA、V4L2 驱动缓冲区、ION 或外设专用的 `dma_buf`），再用 `cv::Mat` 包装这块物理连续内存。

---

## 6 拷贝、移动与`cv::Mat`内存语义验证Demo

### 6.1 `Frame`复制与移动次数验证

验证目标：
通过日志直观观察：对象作为左值和右值插入 `std::vector` 时，究竟走的是复制构造还是移动构造。

```cpp
// frame_copy_move_demo.cpp
#include <iostream>
#include <string>
#include <utility>
#include <vector>

class Frame {
public:
    Frame() : name_("frame-0") {
        std::cout << "[构造] 默认构造 Frame\n";
    }

    // 复制构造：深拷贝内部资源，源对象完全保留
    Frame(const Frame& other) : name_(other.name_) {
        std::cout << "[拷贝] 复制构造 Frame (耗时深拷贝)\n";
    }

    // 移动构造：掏空源对象内部资源，转给自身。标记 noexcept 保障异常安全
    Frame(Frame&& other) noexcept : name_(std::move(other.name_)) {
        std::cout << "[移动] 移动构造 Frame (廉价指针转移)\n";
    }

    ~Frame() {
        std::cout << "[析构] 析构 Frame\n";
    }

private:
    std::string name_;
};

int main() {
    std::vector<Frame> frames;
    // 关键：预留空间，规避 vector 扩容带来的历史元素搬运干扰
    frames.reserve(2);

    Frame source;

    std::cout << "--- 1. 传入左值 source ---\n";
    frames.push_back(source); // source 后续还要用 -> 必须复制

    std::cout << "--- 2. 传入右值 std::move(source) ---\n";
    frames.push_back(std::move(source)); // 明确不再需要 source -> 触发移动

    std::cout << "--- 3. 退出作用域析构 ---\n";
}
```

编译与运行：
```bash
g++ -std=c++17 -Wall -Wextra frame_copy_move_demo.cpp -o frame_copy_move_demo
./frame_copy_move_demo
```

终端输出与行为分析：
```text
[构造] 默认构造 Frame
--- 1. 传入左值 source ---
[拷贝] 复制构造 Frame (耗时深拷贝)
--- 2. 传入右值 std::move(source) ---
[移动] 移动构造 Frame (廉价指针转移)
--- 3. 退出作用域析构 ---
[析构] 析构 Frame
[析构] 析构 Frame
[析构] 析构 Frame
```
可以看到，在预留空间后，左值明确触发拷贝，而 `std::move` 精确触发移动，没有一丝多余开销。

---

### 6.2 `cv::Mat`浅拷贝与`clone()`隔离验证

验证目标：
通过修改像素，验证默认赋值操作的内存共享行为，以及 `clone()` 带来的内存完全隔离。

```cpp
// mat_copy_demo.cpp
#include <opencv2/core.hpp>
#include <iostream>

int main() {
    // 1. 创建 2x2 单通道图像，每个像素初始值均为 10
    cv::Mat original(2, 2, CV_8UC1, cv::Scalar(10));

    // 2. 浅拷贝：仅复制头信息，共享底层像素
    cv::Mat shallow = original;

    // 3. 深拷贝：完整申请新内存并复制像素
    cv::Mat deep = original.clone();

    // 4. 通过浅拷贝修改 (0, 0) 位置的像素
    shallow.at<unsigned char>(0, 0) = 99;

    std::cout << "=== 修改 shallow(0, 0) 为 99 后 ===\n";
    std::cout << "original(0, 0): " << static_cast<int>(original.at<unsigned char>(0, 0)) << " (被连带修改)\n";
    std::cout << "shallow(0, 0) : " << static_cast<int>(shallow.at<unsigned char>(0, 0))  << " (当前值)\n";
    std::cout << "deep(0, 0)    : " << static_cast<int>(deep.at<unsigned char>(0, 0))     << " (完全隔离，仍为原值)\n";

    // 5. 修改 deep 独立副本的 (0, 1) 位置
    deep.at<unsigned char>(0, 1) = 77;
    std::cout << "\n=== 修改 deep(0, 1) 为 77 后 ===\n";
    std::cout << "original(0, 1): " << static_cast<int>(original.at<unsigned char>(0, 1)) << " (不受影响)\n";
    std::cout << "deep(0, 1)    : " << static_cast<int>(deep.at<unsigned char>(0, 1))     << " (独立修改)\n";
}
```

编译与运行：
```bash
g++ -std=c++17 mat_copy_demo.cpp $(pkg-config --cflags --libs opencv4) -o mat_copy_demo
./mat_copy_demo
```

终端输出：
```text
=== 修改 shallow(0, 0) 为 99 后 ===
original(0, 0): 99 (被连带修改)
shallow(0, 0) : 99 (当前值)
deep(0, 0)    : 10 (完全隔离，仍为原值)

=== 修改 deep(0, 1) 为 77 后 ===
original(0, 1): 10 (不受影响)
deep(0, 1)    : 77 (独立修改)
```
结果清晰表明：`shallow` 与 `original` 本质上在操作同一块内存，而 `deep` 拥有独立的生命周期和数据隔离。

---

### 6.3 ROI、`step`与`isContinuous()`验证

验证目标：
截取局部 ROI 图像后，观察其行宽有效字节、`step` 行步长与连续性标志位的变化。

```cpp
// mat_roi_step_demo.cpp
#include <opencv2/core.hpp>
#include <iostream>

int main() {
    // 1. 创建 4 行 6 列的三通道矩阵 (CV_8UC3: 每个像素 3 字节)
    cv::Mat image(4, 6, CV_8UC3, cv::Scalar(0, 0, 0));

    // 2. 从 (x=1, y=1) 开始截取 宽=3, 高=2 的 ROI 区域
    cv::Rect area(1, 1, 3, 2);
    cv::Mat roi = image(area);

    std::cout << "--- 原图 image (全图连续) ---\n";
    std::cout << "尺寸: " << image.rows << "行 x " << image.cols << "列\n";
    std::cout << "每像素大小 (elemSize): " << image.elemSize() << " 字节\n";
    std::cout << "行有效字节 (cols * elemSize): " << image.cols * image.elemSize() << " 字节\n";
    std::cout << "实际行步长 (step): " << image.step << " 字节\n";
    std::cout << "是否连续 (isContinuous): " << (image.isContinuous() ? "true" : "false") << "\n\n";

    std::cout << "--- 截取 ROI (沿用原图 step，内存不连续) ---\n";
    std::cout << "尺寸: " << roi.rows << "行 x " << roi.cols << "列\n";
    std::cout << "每像素大小 (elemSize): " << roi.elemSize() << " 字节\n";
    std::cout << "行有效字节 (cols * elemSize): " << roi.cols * roi.elemSize() << " 字节\n";
    std::cout << "实际行步长 (step): " << roi.step << " 字节 (沿用原图步长！)\n";
    std::cout << "是否连续 (isContinuous): " << (roi.isContinuous() ? "true" : "false") << " (出现断层)\n";
}
```

编译与运行：
```bash
g++ -std=c++17 mat_roi_step_demo.cpp $(pkg-config --cflags --libs opencv4) -o mat_roi_step_demo
./mat_roi_step_demo
```

终端输出：
```text
--- 原图 image (全图连续) ---
尺寸: 4行 x 6列
每像素大小 (elemSize): 3 字节
行有效字节 (cols * elemSize): 18 字节
实际行步长 (step): 18 字节
是否连续 (isContinuous): true

--- 截取 ROI (沿用原图 step，内存不连续) ---
尺寸: 2行 x 3列
每像素大小 (elemSize): 3 字节
行有效字节 (cols * elemSize): 9 字节
实际行步长 (step): 18 字节 (沿用原图步长！)
是否连续 (isContinuous): false (出现断层)
```

**关键数据解读**：
ROI 的宽度是 3，每行有效数据只有 $3 \times 3 = 9$ 字节；但是为了跳到 ROI 下一行的第一个像素，指针必须在原图内存中前进一整行的宽度（即 18 字节）。
因为 $\text{step} (18) \neq 9$，行与行之间存在 9 字节的原图数据断层，所以 `roi.isContinuous()` 必然判定为 `false`。

---

### 6.4 Demo结果与异步图像传递验收

完成上述三个实验后，可以用以下 7 个核心问题快速自测，检验是否彻底吃透这部分内容：

1. **`push_back(source)` 与 `push_back(std::move(source))` 的本质区别是什么？**
   - 前者实参是左值，调用复制构造执行深拷贝；后者将实参转为右值，调用移动构造，仅做指针接管。
2. **`std::move` 自身会搬运内存数据吗？**
   - 不会。它只是一次编译期类型强转，把表达式转为右值引用。真正的资源转移发生在接收方的移动构造函数中。
3. **`cv::Mat b = a;` 会复制底层像素吗？为什么改 `b` 会连带改 `a`？**
   - 不会复制像素。它只拷贝对象头并增加引用计数，二者的 `data` 指针指向同一块堆内存。
4. **`clone()` 解决了什么问题？代价是什么？**
   - 实现了深拷贝，在内存中分配独立副本，彻底隔离数据修改。代价是需要重新申请大块内存并逐字节拷贝，消耗 CPU 算力与内存带宽。
5. **为什么截取的 ROI 其 `step` 通常大于 `cols * elemSize()`？**
   - 因为 ROI 没有开辟新内存，它的下一行像素在物理布局上依然隔着原图一整行的距离，必须沿用原图的行步长才能唯一定位。
6. **`isContinuous() == true` 能否说明可以把这块内存直接交给外设做 DMA 硬件搬运？**
   - 不能。它仅能证明虚拟地址连续，不能证明底层物理页连续。外设 DMA 搬运通常需要连续物理内存（如 CMA 保证）。
7. **相机驱动在下一帧会复用当前内存时，直接将浅拷贝的 `cv::Mat` 塞进异步处理队列是否安全？**
   - **绝对不安全**。OpenCV 的引用计数只能管住自己分配的内存，管不住外部硬件驱动。下一帧数据到达时，底层内存会被硬件静默覆盖，导致处理线程读到撕裂或错误的数据。必须在入队前显式 `.clone()` 制作独立快照，或者设计严格的双缓冲/缓冲池借还机制。