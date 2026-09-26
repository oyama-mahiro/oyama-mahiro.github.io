---
title: '[嵌入式AI-C++工程] STL容器、模板与多态'
published: 2026-09-24T08:03:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍STL容器、模板与多态的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-4 STL容器、模板与多态

标准模板库（Standard Template Library，STL）提供通用容器、迭代器和算法；模板使这些代码能够适用于不同类型；多态则允许调用方通过统一接口使用不同实现。本节重点不是记住全部接口，而是理解容器的存储结构、失效规则、模板参数和虚函数调用机制，并据此选择简单、合适的模块协作方式。

阶段1-3第2节已经介绍了 `std::vector` 插入元素时的复制与移动。本节继续讨论扩容后的地址变化。RAII和智能指针分别见阶段1-1第5节、阶段1-2，后文使用它们管理多态对象时不再重复所有权基础。

## 1 STL的组成、容器分类与常见底层数据结构

### 1.1 容器、迭代器、算法与函数对象

STL的常用组成可以分为四类：

1. **容器（container）**：保存一组对象，例如 `std::vector`、`std::map`。
2. **迭代器（iterator）**：表示容器中的访问位置，作用类似可以移动的元素指针。
3. **算法（algorithm）**：对一个迭代器范围执行查找、排序、复制等操作，例如 `std::find`、`std::sort`。
4. **函数对象（function object）和Lambda表达式**：向算法提供比较或处理规则。

算法通常不直接绑定某一种容器，而是接收半开区间 `[begin, end)`：`begin` 指向第一个元素，`end` 指向最后一个元素之后的位置。这样，同一个算法可以作用于多种提供合适迭代器的容器。

```cpp
#include <algorithm>
#include <vector>

std::vector<int> scores{30, 10, 20};
std::sort(scores.begin(), scores.end());
```

这里：

- `scores.begin()` 返回指向第一个元素的迭代器。
- `scores.end()` 返回尾后迭代器，不能解引用。
- `std::sort` 要求随机访问迭代器，因此可以直接排序 `vector`，不能直接排序 `std::list`。

STL中的“模板”表示这些容器和算法不是只为 `int` 编写。例如，`std::vector<int>` 和 `std::vector<Frame>` 使用同一个类模板生成两种具体类型。

### 1.2 `array`、`vector`、`deque`与链表容器

顺序容器主要按照元素位置组织数据，但内存布局并不相同。

| 容器 | 常见底层结构 | 随机访问 | 主要特点 |
|---|---|---:|---|
| `std::array<T, N>` | 对象内部的固定长度数组 | `O(1)` | 长度 `N` 在编译期确定，不会扩容 |
| `std::vector<T>` | 连续动态数组 | `O(1)` | 尾部插入通常快，扩容会搬迁元素 |
| `std::deque<T>` | 多个固定大小内存块加索引结构 | `O(1)` | 首尾插入快，但全部元素不是一整块连续内存 |
| `std::list<T>` | 双向链表 | `O(n)` | 已知位置插入删除稳定，每个节点有额外指针 |
| `std::forward_list<T>` | 单向链表 | `O(n)` | 只能向前遍历，接口和使用场景较少 |

`std::array<T, N>` 中有两个模板参数：`T` 是元素类型，`N` 是元素数量。例如 `std::array<float, 4>` 保存4个 `float`。它的大小不能在运行时改变。

`std::vector<T>` 通常保存三个逻辑信息：数据起始位置、当前元素数量和当前容量。标准没有要求实现必须恰好使用三个指针，但要求元素连续存储，因此可以把 `data()` 交给需要连续数组的普通C接口。

`std::deque<T>` 支持随机访问，但不能把 `&deque[0]` 当作所有元素连续存储的证明。它通常把元素放在多个内存块中，再通过内部索引找到对应块。

`std::list<T>` 的节点通常分别分配，每个节点保存元素和前后链接。已知迭代器时，在该位置插入或删除不需要移动其他元素；但为了找到这个位置而从头遍历仍然需要 `O(n)` 时间。链表节点分散，也通常不如 `vector` 利于CPU缓存。

因此，不确定选择什么顺序容器时，优先从 `vector` 开始。只有首部插入、地址稳定性或节点拼接等需求确实存在时，再考虑 `deque` 或链表。

### 1.3 `set`、`map`与有序关联容器

关联容器按照**键（key）**组织元素：

- `std::set<Key>`：只保存唯一键。
- `std::multiset<Key>`：保存键，允许重复。
- `std::map<Key, Value>`：保存唯一键及其对应值。
- `std::multimap<Key, Value>`：允许同一个键对应多个值。

主流标准库通常用平衡二叉搜索树实现这些容器，常见选择是红黑树。树会在插入和删除后调整结构，使查找、插入和删除通常保持 `O(log n)`。

需要把“标准保证”与“常见实现”分开：C++标准要求有序关联容器按照比较规则排列，并规定相应复杂度，但没有要求实现必须叫红黑树。业务代码不能访问或依赖其树节点颜色、旋转方式等内部细节。

`map`的元素按键排序，因此适合：

- 需要从小到大遍历键。
- 需要查找某个键范围。
- 需要稳定的迭代顺序，便于输出可复现的配置或报告。

`set`适合只判断“某个键是否存在”并且需要有序遍历的情况。如果还要为键保存额外信息，应使用 `map`，不要再维护一组彼此对应的容器。

### 1.4 `unordered_set`、`unordered_map`与哈希容器

无序关联容器通常使用**哈希表（hash table）**。哈希函数先把键转换为一个数值，再根据该数值定位到某个桶（bucket）；同一个桶中可能保存多个发生哈希冲突的元素。

- `std::unordered_set<Key>`：只保存唯一键，不保证遍历顺序。
- `std::unordered_map<Key, Value>`：保存键值对，不保证遍历顺序。

查找过程通常是：

1. 计算键的哈希值。
2. 根据哈希值找到桶。
3. 在桶内比较实际键，排除哈希冲突。

在哈希分布合理时，查找、插入和删除的平均复杂度通常为 `O(1)`；但这不是所有情况下的固定耗时。大量键落入同一桶时，最坏可退化为 `O(n)`。

元素数量相对桶数量过多时，容器可能执行**重新哈希（rehash）**：建立新的桶结构并重新安排元素所在的桶。重新哈希会使已有迭代器失效。因此，已知大致元素数量时可以使用 `reserve()` 提前准备足够桶空间。

`unordered_map`适合通过名称快速查找处理器、配置或模型信息；如果日志和测试依赖稳定的遍历顺序，则应排序结果或选择 `map`，不能依赖一次运行中偶然观察到的顺序。

### 1.5 `stack`、`queue`与`priority_queue`容器适配器

容器适配器不是新的底层存储结构，而是在已有容器上提供受限制的操作接口：

- `std::stack<T>`：后进先出，只暴露 `push`、`pop`、`top` 等栈操作，默认包装 `deque`。
- `std::queue<T>`：先进先出，只从队尾放入、队首取出，默认包装 `deque`。
- `std::priority_queue<T>`：每次访问当前优先级最高的元素，默认使用 `vector` 保存元素并维护堆结构。

`priority_queue`中的“堆（heap）”是一种满足局部顺序的数据结构。默认情况下，`top()` 返回最大元素。它不会像 `map` 那样让全部元素始终按顺序遍历，只保证最高优先级元素位于顶部。

容器适配器有意不暴露底层容器的全部接口。例如，`queue`没有迭代器，因为它表达的是先进先出的访问约束。如果业务必须遍历队列中全部任务，应先确认自己需要的是否真是队列抽象。

## 2 STL容器选择、常用操作与迭代器失效

### 2.1 根据内存布局、访问方式与查找需求选择容器

选择容器时按需求判断，不要只比较一项理论复杂度：

| 需求 | 优先考虑 | 原因 |
|---|---|---|
| 连续内存、按下标访问、批量遍历 | `vector` | 连续布局，缓存局部性好 |
| 固定数量元素 | `array` | 不需要动态分配和扩容 |
| 首尾频繁插入删除 | `deque` | 两端操作方便 |
| 已知节点位置并频繁插入删除 | `list` | 不搬迁其他节点 |
| 键需要排序或范围查询 | `map`、`set` | 始终按比较规则有序 |
| 只需快速按键查找 | `unordered_map`、`unordered_set` | 平均常数时间查找 |
| 先进先出 | `queue` | 接口直接表达约束 |
| 每次取最高优先级任务 | `priority_queue` | 堆顶直接提供最高优先级元素 |

`vector`常常是默认选择，即使中间插入理论上是 `O(n)`，连续内存带来的缓存优势也可能让它在中小规模数据上优于节点容器。只有实际需求或测量结果表明不合适时再替换。

### 2.2 `map`、`unordered_map`与`set`的常用操作

以下成员函数适用于常见关联容器，具体返回类型略有差异：

- `insert(value)`：插入已经构造好的元素。
- `emplace(arguments...)`：使用参数在容器中构造元素。
- `find(key)`：查找键；不存在时返回 `end()`，不会自动插入。
- `at(key)`：返回键对应的值；不存在时抛出 `std::out_of_range`。
- `operator[](key)`：只适用于映射容器；不存在时插入一个默认构造的值。
- `erase(key)`：删除指定键，返回删除的元素数量。

只查询时不要随手使用 `operator[]`：

```cpp
std::map<std::string, int> counters;

int value = counters["camera"]; // 键不存在时，自动插入 camera -> 0
```

如果不希望改变容器，应使用 `find()`：

```cpp
const auto position = counters.find("camera");
if (position != counters.end()) {
    std::cout << position->second << '\n';
}
```

这里 `auto` 让编译器推导迭代器类型；`position->first` 是键，`position->second` 是值。`position`只在没有发生会使其失效的容器操作期间有效。

`set`的元素本身就是键，因此不能通过迭代器修改键。若允许直接修改，树或哈希表内部用于定位元素的规则就可能被破坏。需要改变键时，应删除旧键再插入新键。

### 2.3 `vector`扩容与指针、引用、迭代器失效

`vector`需要区分两个数量：

- `size()`：已经存在多少个元素。
- `capacity()`：当前已分配内存最多能容纳多少个元素。

`reserve(n)`保证容量至少达到 `n`，但不会创建元素，也不会改变 `size()`。当插入导致元素数量超过当前容量时，`vector`通常执行：

1. 申请一块更大的连续内存。
2. 把已有元素移动或复制到新内存。
3. 销毁旧位置的元素。
4. 释放旧内存。

因此，指向旧内存的指针、引用和迭代器全部失效。继续解引用它们属于未定义行为。

下面的小程序只比较地址，不解引用失效指针，因此不会故意执行未定义行为。

```cpp
// vector_invalidation_demo.cpp
#include <iostream>
#include <vector>

int main() {
    std::vector<int> values;
    values.reserve(2);
    values.push_back(10);
    values.push_back(20);

    // data() 返回当前连续存储区的首地址。
    // 只保存地址用于比较；扩容后绝不能通过 old_data 读取元素。
    const int* old_data = values.data();
    const std::size_t old_capacity = values.capacity();

    // size 已等于 capacity，再插入一个元素会触发扩容。
    values.push_back(30);

    std::cout << "old capacity: " << old_capacity << '\n';
    std::cout << "new capacity: " << values.capacity() << '\n';
    std::cout << "storage changed: "
              << (old_data != values.data()) << '\n';
}
```

依赖：C++17标准库。输入：程序内部的三个整数。编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic vector_invalidation_demo.cpp -o vector_invalidation_demo
./vector_invalidation_demo
```

`storage changed`通常输出 `1`。验收重点不是具体新容量，因为标准没有规定容量必须按几倍增长；重点是扩容后旧地址不得继续使用。

### 2.4 删除、重新哈希与不同容器的迭代器失效规则

不同容器的失效规则不能互相套用：

| 操作 | 主要失效结果 |
|---|---|
| `vector`扩容 | 所有指针、引用和迭代器失效 |
| `vector::erase` | 删除位置及其后面的迭代器、引用和指针失效 |
| `list::erase` | 被删除节点的迭代器失效，其他节点通常不受影响 |
| `map/set::erase` | 被删除元素的迭代器失效，其他元素通常不受影响 |
| `unordered_map/set`重新哈希 | 迭代器失效；元素引用和指针的规则与删除不同，使用前应按接口要求确认 |
| 任意容器删除某个元素 | 指向被删除元素的指针、引用和迭代器失效 |

遍历时删除元素，应使用 `erase`返回的下一个有效迭代器：

```cpp
for (auto position = values.begin(); position != values.end();) {
    if (*position < 0) {
        position = values.erase(position);
    } else {
        ++position;
    }
}
```

这里不能在 `erase(position)` 后再对旧 `position` 执行 `++position`，因为旧位置已经失效。

调试容器失效问题时，应依次检查：保存地址的位置、容器的所有插入删除操作、容量变化、失效地址的最后一次使用。地址消毒器（AddressSanitizer，ASan，已在阶段1-1第7节介绍）可以帮助发现部分失效地址访问，但不能替代对容器规则的判断。

## 3 类模板与循环队列

### 3.1 类模板、类型参数、非类型参数与具体类型

类模板是生成一组相似类的规则。基本语法如下：

```cpp
template <typename T, std::size_t Capacity>
class CircularQueue;
```

每一部分的含义是：

- `template`：说明后面的声明依赖模板参数。
- `typename T`：声明一个名为 `T` 的类型参数，决定队列保存什么类型的元素。
- `std::size_t Capacity`：声明一个非类型模板参数，值表示队列固定容量。`std::size_t`是标准库表示对象大小和元素数量的无符号整数类型。
- `CircularQueue`：类模板的名字。
- `CircularQueue<T, Capacity>`：在模板定义内部表示当前生成的循环队列类型。

使用时必须给出具体类型：

```cpp
CircularQueue<int, 3> number_queue;
CircularQueue<FrameInfo, 2> frame_queue;
```

`int`和`FrameInfo`分别替换类型参数 `T`，`3`和`2`分别替换容量参数 `Capacity`。编译器据此生成两种互不相同的具体类型。元素类型和容量都在编译期确定，不是在运行时选择。

这与构造函数参数不同：模板实参决定**生成什么类型**，构造函数参数决定**怎样初始化一个对象**。阶段1-2第2.3节已经用 `std::unique_ptr<CHandle, HandleDeleter>` 区分过这两类参数。

### 3.2 模板定义位置与编译期实例化

编译器看到 `CircularQueue<FrameInfo, 2>` 时，需要同时看到模板的完整定义，才能生成对应代码，这个过程称为**模板实例化（template instantiation）**。因此，简单模板通常把声明和定义一起放在头文件中。

如果只在头文件声明模板，却把成员函数定义放进普通 `.cpp` 文件，其他编译单元实例化模板时可能看不到定义，最终出现链接错误。也可以在 `.cpp` 中显式实例化预先确定的类型，但这不是本阶段循环队列的主路径。

模板代码并非对任意 `T` 都一定成立。代码对 `T` 执行了什么操作，`T` 就必须支持什么能力。例如，把 `T` 移动进容器，要求它能够以相应方式构造；输出 `T` 则要求存在合适的输出运算符。

模板编译错误可能很长。排查时先找：

1. 自己代码中第一次实例化模板的位置。
2. 编译器最先报告“不存在某成员”或“无法匹配某操作”的位置。
3. 模板对 `T` 执行了什么，而具体类型是否支持。

### 3.3 使用类模板实现固定容量循环队列

**循环队列（circular queue，也叫ring buffer）**使用一组固定槽位保存元素。读下标和写下标到达最后一个槽位后回到0，因此已弹出的槽位可以被后续元素重复使用，不需要搬移其他元素。

实现需要保存三个状态：

- `head_`：下一次弹出元素的槽位下标。
- `tail_`：下一次写入元素的槽位下标。
- `size_`：当前已有元素数量，用于区分队列为空和队列已满。

每次读写后使用 `(下标 + 1) % Capacity`计算下一位置。`%`是取余运算：容量为3时，下标变化为 `0 → 1 → 2 → 0`，最后一步就是回绕。

代码还使用 `std::array<std::optional<T>, Capacity>`：

- `std::array<元素类型, 数量>`提供编译期固定长度数组。
- `std::optional<T>`定义在 `<optional>`中，一个对象要么保存一个 `T`，要么处于无值状态。
- 每个 `optional`表示对应槽位当前是否保存元素，因此队列不要求 `T`必须能默认构造。
- `pop()`返回 `std::optional<T>`；队列为空时返回 `std::nullopt`，调用方必须判断后再取值。

这个小Demo只验证固定容量、满队列拒绝写入、先进先出和下标回绕。它不包含锁、条件变量和关闭状态；这些并发能力留到阶段1-5和1-6。`std::move`的作用见阶段1-3第1.3节。

```cpp
// circular_queue_demo.cpp
#include <array>
#include <cstddef>
#include <iostream>
#include <optional>
#include <utility>

template <typename T, std::size_t Capacity>
class CircularQueue {
    static_assert(Capacity > 0, "CircularQueue capacity must be greater than zero");

public:
    bool push(T value) {
        if (full()) {
            // 固定容量已经用完，本Demo选择拒绝新元素，不覆盖旧元素。
            return false;
        }

        // 在当前写下标对应的空槽位中构造元素。
        slots_[tail_].emplace(std::move(value));
        tail_ = (tail_ + 1) % Capacity;
        ++size_;
        return true;
    }

    std::optional<T> pop() {
        if (empty()) {
            return std::nullopt;
        }

        // 先移动队首元素，再把该槽位恢复为无值状态。
        std::optional<T> value = std::move(slots_[head_]);
        slots_[head_].reset();
        head_ = (head_ + 1) % Capacity;
        --size_;
        return value;
    }

    bool empty() const {
        return size_ == 0;
    }

    bool full() const {
        return size_ == Capacity;
    }

    std::size_t size() const {
        return size_;
    }

private:
    std::array<std::optional<T>, Capacity> slots_{};
    std::size_t head_{0};
    std::size_t tail_{0};
    std::size_t size_{0};
};

int main() {
    CircularQueue<int, 3> queue;

    queue.push(10);
    queue.push(20);
    queue.push(30);

    // 容量为3且已有3个元素，第4次写入应被拒绝。
    std::cout << "accept 99: " << queue.push(99) << '\n';

    const std::optional<int> first = queue.pop();
    if (first.has_value()) {
        std::cout << "first pop: " << *first << '\n';
    }

    // 弹出10后空出一个槽位；写下标已经回绕到0，40写入槽位0。
    std::cout << "accept 40: " << queue.push(40) << '\n';

    while (!queue.empty()) {
        const std::optional<int> value = queue.pop();
        std::cout << "pop: " << *value << '\n';
    }

    std::cout << "empty: " << queue.empty() << '\n';
}
```

`has_value()`用于判断 `optional`是否有值，`*first`用于取得其中的 `int`。循环中的 `*value`是安全的，因为进入循环前已经用 `empty()`确认队列有元素，而且本Demo没有其他线程同时修改队列。

依赖：C++17标准库。输入：程序内部的整数。编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic circular_queue_demo.cpp -o circular_queue_demo
./circular_queue_demo
```

预期输出：

```text
accept 99: 0
first pop: 10
accept 40: 1
pop: 20
pop: 30
pop: 40
empty: 1
```

这个顺序同时证明：满队列不会覆盖尚未读取的数据；弹出顺序符合先进先出；写下标回绕后，40复用了10原来占用的槽位。空队列再调用 `pop()`时应得到没有值的 `std::optional<int>`，不能直接解引用。

## 4 虚函数、动态多态与虚函数表

### 4.1 虚函数、纯虚函数、`override`与抽象类

**多态（polymorphism）**表示同一个调用形式可以表现出不同具体行为。C++的运行时多态通常由基类引用或指针配合虚函数实现。

先看一个接口类的基本语法：

```cpp
class IProcessor {
public:
    virtual void process() = 0;
    virtual ~IProcessor() = default;
};
```

每一部分的含义是：

- `virtual`：这个成员函数参与运行时动态派发。
- `void process()`：函数名是 `process`，无参数，无返回值。
- `= 0`：把函数声明为纯虚函数。这里不是给函数赋值，而是C++规定的纯虚函数语法。
- `virtual ~IProcessor()`：虚析构函数，保证通过基类指针销毁派生对象时执行完整析构链。
- `= default`：要求编译器生成默认析构实现。

至少含一个纯虚函数的类是**抽象类（abstract class）**，不能直接创建对象。派生类必须实现仍未实现的纯虚函数，才可以创建具体对象：

```cpp
class CpuProcessor final : public IProcessor {
public:
    void process() override {
        // CPU版本的处理逻辑
    }
};
```

- `public IProcessor`表示公开继承，`CpuProcessor`可以被当作 `IProcessor` 使用。
- `override`要求编译器检查这个函数是否真的覆盖了基类虚函数。参数类型、`const`限定或函数名不一致时，编译器会直接报错。
- `final`表示不允许继续从 `CpuProcessor` 派生。只有确实需要禁止扩展时才使用，不必给所有类机械添加。

接口类通常只表达调用约定，不应塞入大量可变业务状态。若两个实现只共享少量工具代码，可以使用普通辅助函数或组合对象，不必把接口基类变成庞大的公共实现基类。

### 4.2 静态绑定与动态派发

**静态绑定（static binding）**表示编译器根据表达式的静态类型确定调用目标。普通非虚成员函数通常采用这种方式。

**动态派发（dynamic dispatch）**表示程序运行时根据对象的实际类型选择最终虚函数实现：

```cpp
CpuProcessor cpu;
IProcessor& processor = cpu;
processor.process(); // 调用CpuProcessor::process()
```

这里要区分两个类型：

- 表达式 `processor` 的静态类型是 `IProcessor&`，编译时可知。
- 它实际引用的对象类型是 `CpuProcessor`，运行时用于选择虚函数实现。

如果 `process`不是虚函数，上面的调用会按照静态类型选择 `IProcessor::process`。声明为虚函数后，才会根据实际对象选择覆盖版本。

动态多态主要解决的是“调用方依赖统一接口，但具体实现可以替换”。它不意味着所有成员函数都应该是虚函数，也不负责管理对象所有权。

### 4.3 虚函数表、虚表指针与虚函数调用过程

一个声明或继承了虚函数的类，通常会有对应的虚函数表。编译器根据继承和重写关系，在编译、链接阶段生成各类型的虚函数表。派生类没有重写的虚函数通常继续指向基类实现，重写的虚函数则指向派生类实现。

虚函数表单独保存在程序的静态数据区域，同一类型的对象通常共享一张表。每个多态对象内部通常保存自己的虚表指针（virtual table pointer，vptr），用来指向当前对象应使用的虚函数表。vptr在对象中的具体位置由编译器决定，不能假定它一定在开头或结尾。

先看一个具体例子：

```cpp
class Base {
public:
    virtual void start();
    virtual void run();
};

class Derived : public Base {
public:
    void run() override;
};
```

`Base`声明了两个虚函数，因此通常有一张对应的虚函数表：

```text
Base虚函数表
┌─────────────────────┐
│ start → Base::start │
│ run   → Base::run   │
└─────────────────────┘
```

`Derived`继承了虚函数，因此通常也有自己的虚函数表。它没有重写 `start()`，所以继续使用 `Base::start()`；它重写了 `run()`，所以对应位置改为 `Derived::run()`：

```text
Derived虚函数表
┌────────────────────────┐
│ start → Base::start    │
│ run   → Derived::run   │
└────────────────────────┘
```

这里可以把派生类虚函数表理解成“以基类虚函数关系为基础生成的新表”，但不是程序运行时先复制一张基类表，再修改其中的指针。编译器在编译派生类时，已经根据哪些函数被重写，准备好派生类对应的表。

**虚函数表保存在哪里**

虚函数表不放在每个对象里面。它通常作为一份由同类型对象共享的数据，保存在可执行文件或动态库的静态数据区域，程序启动后被加载到内存：

```text
程序内存
├── 代码区域
│   ├── Base::start的机器指令
│   ├── Base::run的机器指令
│   └── Derived::run的机器指令
│
├── 静态数据区域
│   ├── Base虚函数表
│   └── Derived虚函数表
│
├── 栈
│   └── 局部对象
│
└── 堆
    └── new创建的对象
```

因此，创建三个 `Derived`对象时，通常不是创建三张虚函数表，而是三个对象共同使用一张 `Derived`虚函数表。

**vptr保存在哪里**

类的对象布局中通常会增加一个隐藏的vptr位置，但每个对象都有自己的vptr。编译器在构造对象时，自动让它指向正确的虚函数表：

```text
first对象 ──自己的vptr──┐
second对象──自己的vptr──┼──→ 共享的Derived虚函数表
third对象 ──自己的vptr──┘
```

在简单单继承的常见实现中，vptr经常位于对象开头，但C++标准没有规定它必须在开头，也没有规定它必须在结尾。多重继承时，一个完整对象还可能包含多个vptr。因此，业务代码不能依赖vptr的具体偏移。

还要区分下面两个指针：

```cpp
Base* object = new Derived;
```

- `object`是程序员声明的基类指针，保存 `Derived`对象的地址。
- vptr是对象内部由编译器添加的隐藏指针，指向 `Derived`虚函数表。

它们不是同一个指针。

执行虚函数调用时：

```cpp
object->run();
```

可以按下面的顺序理解：

1. `object`找到实际的 `Derived`对象。
2. 程序从对象内部取得vptr。
3. vptr找到 `Derived`虚函数表。
4. 程序从表中找到 `run`对应的函数地址。
5. 因为该位置保存的是 `Derived::run()`，所以最终调用派生类实现。

```text
Base* object
     ↓
Derived对象
     ↓ 读取对象内部vptr
Derived虚函数表
     ↓ 查找run对应位置
Derived::run()
```

抽象类虽然不能直接创建对象，但只要它声明了虚函数，编译器通常仍会为它准备相应的虚函数表信息。具体派生类继承或重写这些虚函数后，也会有与自己最终函数实现对应的虚函数表。

初学阶段可以把虚函数表理解为“保存虚函数地址的表”。实际实现还可能包含虚析构入口、运行时类型信息和继承所需的偏移，但这些细节不影响当前判断。

需要注意：C++标准只规定虚函数必须正确实现动态派发，没有强制编译器一定使用vtable和vptr。以上是GCC、Clang、MSVC等主流编译器的常见实现模型，可参考[Itanium C++ ABI虚函数表规范](https://itanium-cxx-abi.github.io/cxx-abi/abi.html#vtable)。

### 4.4 虚函数的对象空间和调用成本

含虚函数的对象在主流实现中通常需要保存至少一个虚表指针，因此对象大小可能增加。虚函数调用通常还会多一次间接寻址，并可能让编译器更难直接内联目标函数。

但不能简单得出“虚函数很慢”的结论：

- 一次推理、图像缩放或设备I/O的耗时通常远大于一次虚函数派发。
- 编译器在能确定实际类型时，可能执行去虚拟化，直接调用目标函数。
- 真正影响性能的还包括缓存命中、对象布局和调用频率。

正确方法是先根据模块是否需要运行时替换实现决定是否使用虚函数，再对热点路径测量。不要为了避免一次间接调用，把清晰接口改成巨大的类型判断分支；也不要把逐像素最内层循环中的每个操作都无条件设计成虚函数。

下面的小程序会打印普通对象和多态对象的大小，但输出只用于观察当前环境，不能写成跨平台固定结论：

```cpp
struct PlainObject {
    int value;
};

struct PolymorphicObject {
    virtual void run() {}
    int value;
};

std::cout << sizeof(PlainObject) << '\n';
std::cout << sizeof(PolymorphicObject) << '\n';
```

`sizeof`返回类型或对象占用的字节数。多态对象的结果还会受到指针宽度和内存对齐影响。

### 4.5 构造、析构期间的虚函数调用与对象切片

构造派生对象时，基类部分先构造，派生部分此时尚未存在；析构时则先销毁派生部分，再销毁基类部分。因此，在构造函数或析构函数中调用虚函数，不会像对象完整存活期间那样派发到尚未构造或已经销毁的派生部分。

在常见vptr实现中，编译器会配合这个生命周期规则调整vptr：进入基类构造阶段时使用基类阶段对应的虚表，进入派生类构造阶段后再改为派生类型对应的虚表；析构时按相反方向逐步恢复到当前仍然存活的类层次。这样，基类构造函数不会通过虚调用访问尚未构造的派生类成员，基类析构函数也不会访问已经销毁的派生类成员。这些vptr写入由编译器生成，不需要手工编写。

直接规则是：不要在基类构造函数或析构函数中调用一个依赖派生类状态的虚函数。应把需要动态派发的初始化或关闭操作放到对象完整构造后的普通调用流程中。

**对象切片（object slicing）**发生在把派生对象按值复制成基类对象时：

```cpp
void run_by_value(IProcessor processor); // 抽象类本身无法这样实例化
```

对于可实例化的普通基类，按值接收派生对象只会复制基类部分，派生类新增的成员被“切掉”。需要保留动态类型时，应使用基类引用或智能指针：

```cpp
void run_by_reference(IProcessor& processor);
void take_ownership(std::unique_ptr<IProcessor> processor);
```

第一种不取得所有权，只在调用期间使用对象；第二种取得唯一所有权。`std::unique_ptr`的所有权转移见阶段1-2第2节。

## 5 接口类、虚析构与组合设计

### 5.1 接口基类与派生类实现

接口基类声明调用方可以做什么，派生类负责怎样做。一个实用接口应当：

- 职责单一，函数数量有限。
- 参数和返回值能表达必要信息与错误。
- 不要求调用方了解派生类内部状态。
- 明确对象由谁创建、保存和销毁。

例如，预处理接口可以只定义一个处理操作，而不把相机采集、模型推理和结果保存都放进同一个基类。接口过宽会迫使不同实现提供自己并不需要的函数。

通过基类引用调用派生实现时，对象必须比引用活得更久；通过智能指针保存时，智能指针负责对应的所有权。多态只解决调用选择，不自动解决生命周期。

### 5.2 通过基类指针销毁对象时的虚析构过程

只要一个类可能通过基类指针被删除，它的析构函数就必须是虚函数：

```cpp
class IProcessor {
public:
    virtual void process() = 0;
    virtual ~IProcessor() = default;
};
```

如果缺少虚析构，下面的删除行为属于未定义行为：

```cpp
IProcessor* processor = new CpuProcessor;
delete processor;
```

在主流虚表实现中，虚析构相关入口使 `delete`能够找到实际派生类型的析构过程。正确顺序是：

1. 执行 `CpuProcessor`析构函数，清理其成员。
2. 执行 `IProcessor`析构函数。
3. 释放完整对象的内存。

这与阶段1-1的RAII直接相关。如果派生类成员拥有文件、缓冲区或设备句柄，跳过派生类析构就可能跳过这些成员的正常清理。

构造函数不能声明为虚函数，因为进行虚派发前必须先存在一个具有实际类型的对象。对象创建差异通常交给工厂函数解决，而不是“虚构造函数”。

### 5.3 接口对象与智能指针

常见接口对象可以这样创建：

```cpp
std::unique_ptr<IProcessor> processor =
    std::make_unique<CpuProcessor>();
```

需要逐项理解：

- `std::unique_ptr<IProcessor>`：变量类型，表示它独占拥有一个可通过 `IProcessor`接口访问的对象。
- `std::make_unique<CpuProcessor>()`：创建具体的 `CpuProcessor`对象，并返回拥有它的智能指针。
- 从 `unique_ptr<CpuProcessor>`转换为 `unique_ptr<IProcessor>`后，所有权仍然只有一份。
- 最终通过基类智能指针销毁对象，所以 `IProcessor`必须提供虚析构函数。

下面的完整Demo验证动态派发和析构顺序：

```cpp
// virtual_dispatch_demo.cpp
#include <iostream>
#include <memory>

class IProcessor {
public:
    virtual void process() = 0;

    virtual ~IProcessor() {
        std::cout << "destroy IProcessor\n";
    }
};

class CpuProcessor final : public IProcessor {
public:
    void process() override {
        std::cout << "CpuProcessor::process\n";
    }

    ~CpuProcessor() override {
        std::cout << "destroy CpuProcessor\n";
    }
};

int main() {
    // 智能指针的静态类型是unique_ptr<IProcessor>，
    // 实际拥有的对象类型是CpuProcessor。
    std::unique_ptr<IProcessor> processor =
        std::make_unique<CpuProcessor>();

    processor->process();
}
```

编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic virtual_dispatch_demo.cpp -o virtual_dispatch_demo
./virtual_dispatch_demo
```

预期输出：

```text
CpuProcessor::process
destroy CpuProcessor
destroy IProcessor
```

第一行证明虚函数派发到实际派生类；后两行证明虚析构让派生部分先清理、基类部分后清理。

### 5.4 接口继承、实现继承与对象组合的选择

可以先使用两条直接规则：

- “A是一种B”，并且调用方确实需要把不同A当成B替换使用时，考虑接口继承。
- “A使用B完成一部分工作”时，使用对象组合。

例如，`CpuPreprocessor`是一种 `IPreprocessor`实现，适合接口继承；`Pipeline`使用预处理器、推理器和结果处理器，适合把这些组件保存为成员，而不是同时继承它们。

**接口继承**主要复用调用约定；**实现继承**还复用基类代码和状态，耦合更强；**组合**让对象通过成员协作，通常更容易替换和单独测试。

如果一个组件需要由外部传入，这种做法常称为**依赖注入（dependency injection）**。它不一定需要框架，构造函数参数就可以完成：

```cpp
class Pipeline {
public:
    explicit Pipeline(std::unique_ptr<IProcessor> processor)
        : processor_(std::move(processor)) {}

private:
    std::unique_ptr<IProcessor> processor_;
};
```

`explicit`防止单参数构造函数参与意外的隐式转换；构造参数把处理器所有权移动到成员中。这里的核心是组合：`Pipeline`拥有并使用处理器，但它不是一种处理器。

### 5.5 过深继承树的常见问题

继承层次过深常出现以下问题：

- 修改上层受保护成员会影响许多派生类。
- 调用行为分散在多层覆盖函数中，难以判断最终执行哪一层。
- 派生类为了复用少量代码，被迫接受不需要的状态和接口。
- 构造、析构和所有权关系变得复杂。
- 测试某个功能时必须构造整条继承链。

不要为了“使用多态”给每个模块都建立基类。只有一个稳定实现、没有替换需求时，普通具体类通常更清楚。需要复用算法时，优先考虑普通函数或成员对象；需要替换行为时，再引入小接口。

## 6 设计模式的选择与五种常用模式

设计模式是对常见设计问题及其解决结构的命名，不是必须套用的代码模板。先确认问题，再选择模式；如果普通函数、成员对象或一个清楚的条件分支已经足够，就不需要模式。

### 6.1 根据模块协作问题选择设计模式

| 当前问题 | 优先考虑 | 识别信号 | 不应使用的情况 |
|---|---|---|---|
| 一个事件要通知多个接收者 | 观察者模式 | 一对多通知、订阅和取消订阅 | 只有一个固定调用目标 |
| 同一步骤需要替换不同算法 | 策略模式 | 总流程不变，某一步实现可替换 | 只有一个很简单的条件分支 |
| 根据配置创建不同具体对象 | 工厂模式 | 调用方不应依赖具体类的构造细节 | 永远只创建一个固定类型 |
| 第三方接口与项目接口不一致 | 适配器模式 | 功能已有，但参数、返回值或命名不兼容 | 可以直接使用且接口已经一致 |
| 不修改原类而叠加日志、统计等行为 | 装饰器模式 | 新功能包在原调用前后，且可能组合 | 直接改原类更简单且不会破坏职责 |
| 一个对象只是使用另一个对象 | 直接组合 | 没有动态替换和一对多协作 | 不要为了模式而增加接口层 |

三个最容易混淆的职责是：

- 工厂负责**创建哪个对象**。
- 策略负责**执行哪一种算法**。
- 观察者负责**把结果通知给谁**。

适配器负责把不兼容接口转换成项目接口；装饰器负责在不改变核心实现的情况下包上一层附加行为。一个系统可以同时使用多个模式，但每一层应能明确回答自己解决的具体问题。

### 6.2 观察者模式的订阅、通知与生命周期

**观察者模式（Observer Pattern）**用于一个发布者发生事件后通知多个观察者。它适合推理结果同时交给显示、保存和告警模块。

参与者通常包括：

- 发布者：保存订阅关系，并在事件发生时逐个通知。
- 观察者接口：规定接收通知的函数。
- 具体观察者：实现显示、保存或统计等行为。

最小结构如下：

```cpp
class IResultObserver {
public:
    virtual void on_result(int class_id) = 0;
    virtual ~IResultObserver() = default;
};

class ResultPublisher {
public:
    void subscribe(IResultObserver& observer) {
        // 保存的是非拥有型指针，发布者不负责delete观察者。
        observers_.push_back(&observer);
    }

    void publish(int class_id) {
        for (IResultObserver* observer : observers_) {
            observer->on_result(class_id);
        }
    }

private:
    std::vector<IResultObserver*> observers_;
};
```

这段代码依赖第1节的 `vector`、第4节的接口多态，以及阶段1-1第6节讲过的非拥有型裸指针。`IResultObserver*`只观察对象，不负责释放。

实际项目必须补齐取消订阅和生命周期规则：观察者销毁前应从发布者中移除，否则容器中会留下悬空指针。若通知期间允许观察者取消订阅，还不能一边遍历同一 `vector`一边随意删除元素。跨线程通知还需要阶段1-5的同步机制；观察者模式本身不提供线程安全。

适用：接收者数量会变化，发布者不应逐个依赖具体接收者。

不适用：只有一个固定目标时，直接函数调用更清楚；需要返回一个同步计算结果时，也不必先改造成事件广播。

### 6.3 策略模式的算法替换与对象组合

**策略模式（Strategy Pattern）**把一组可互换算法放在统一接口后面，使用者通过组合持有其中一种策略。适合总流程不变、某一步算法需要替换的情况。

例如，预处理流程都需要调用 `run`，但具体归一化方法不同：

```cpp
class IPreprocessStrategy {
public:
    virtual float run(float pixel) const = 0;
    virtual ~IPreprocessStrategy() = default;
};

class ZeroToOneStrategy final : public IPreprocessStrategy {
public:
    float run(float pixel) const override {
        return pixel / 255.0F;
    }
};

class CenteredStrategy final : public IPreprocessStrategy {
public:
    float run(float pixel) const override {
        return pixel / 127.5F - 1.0F;
    }
};

class Preprocessor {
public:
    explicit Preprocessor(std::unique_ptr<IPreprocessStrategy> strategy)
        : strategy_(std::move(strategy)) {}

    float process(float pixel) const {
        return strategy_->run(pixel);
    }

private:
    // Preprocessor拥有当前策略，策略通过接口替换。
    std::unique_ptr<IPreprocessStrategy> strategy_;
};
```

`IPreprocessStrategy`定义算法接口，`ZeroToOneStrategy`提供具体算法，`Preprocessor`是使用策略的上下文对象。`Preprocessor`没有继承策略，而是拥有策略，这就是“组合优先于为了复用而继承”。

如果只有两行简单条件且短期不会扩展，普通 `if/else`可能更清楚。策略模式适合算法本身有独立状态、需要单独测试，或实现数量持续增加的情况。

### 6.4 工厂模式的对象创建与错误处理

**工厂模式（Factory Pattern）**把“根据条件创建哪一种具体对象”的判断集中起来。调用方只依赖接口，不需要知道每个具体类的构造细节。

本节只使用简单工厂函数，不展开抽象工厂等更复杂变体：

```cpp
std::unique_ptr<IPreprocessStrategy>
create_strategy(const std::string& name) {
    if (name == "zero_to_one") {
        return std::make_unique<ZeroToOneStrategy>();
    }

    if (name == "centered") {
        return std::make_unique<CenteredStrategy>();
    }

    throw std::invalid_argument("unknown preprocess strategy: " + name);
}
```

返回类型 `std::unique_ptr<IPreprocessStrategy>`表示调用方获得一个接口对象的唯一所有权；具体返回对象可以是不同派生类型。`std::invalid_argument`定义在 `<stdexcept>`中，表示调用者提供了不支持的名称。

未知配置不能默默创建一个随意默认对象，否则配置拼写错误可能直到结果异常时才被发现。可以抛异常，也可以使用项目统一的错误返回方式，但必须让失败可见。

工厂只负责创建。对象创建后怎样执行算法是策略接口的职责；不要把整个业务流程也塞进工厂函数。

### 6.5 适配器模式的接口转换

**适配器模式（Adapter Pattern）**用于已有类能够完成目标功能，但接口与项目期望不一致的情况。适配器包装已有对象，把项目参数转换成旧接口参数，再把结果转换回来。

假设第三方推理库只能接收裸地址和元素数量：

```cpp
class ThirdPartyRuntime {
public:
    int execute(const float* data, std::size_t element_count);
};
```

项目希望统一使用 `std::vector<float>`：

```cpp
class IRuntime {
public:
    virtual int infer(const std::vector<float>& input) = 0;
    virtual ~IRuntime() = default;
};

class RuntimeAdapter final : public IRuntime {
public:
    int infer(const std::vector<float>& input) override {
        // data()提供连续数组首地址，size()提供元素数量。
        return runtime_.execute(input.data(), input.size());
    }

private:
    ThirdPartyRuntime runtime_;
};
```

`RuntimeAdapter`实现项目接口，同时组合第三方对象。它负责接口转换，不应悄悄改变输入尺度、通道顺序或错误语义。如果必须转换这些语义，应在接口说明和测试中明确写出。

适配器与装饰器外表都像“包一层”，但目的不同：适配器改变接口形状，装饰器保持相同接口并添加行为。

### 6.6 装饰器模式的功能叠加

**装饰器模式（Decorator Pattern）**让包装对象和被包装对象实现同一个接口。包装对象在调用前后增加行为，再把核心工作转发给内部对象。

下面的日志装饰器不改变 `IProcessor`接口：

```cpp
class LoggingProcessor final : public IProcessor {
public:
    explicit LoggingProcessor(std::unique_ptr<IProcessor> inner)
        : inner_(std::move(inner)) {}

    void process() override {
        std::cout << "process begin\n";
        inner_->process();
        std::cout << "process end\n";
    }

private:
    // 装饰器拥有真正完成处理的对象。
    std::unique_ptr<IProcessor> inner_;
};
```

创建时可以把具体处理器包进去：

```cpp
std::unique_ptr<IProcessor> processor =
    std::make_unique<LoggingProcessor>(
        std::make_unique<CpuProcessor>());
```

先创建 `CpuProcessor`，再把其所有权交给 `LoggingProcessor`，最终调用方仍只看到 `IProcessor`。这种结构可以继续叠加计时或统计装饰器。

需要注意：装饰层过多会让调用链和错误位置难以追踪。若附加行为永远只服务一个具体类，直接在该类中清楚实现可能更简单。装饰器也不能自动解决线程安全和异常处理问题。

### 6.7 容器、模板、多态与设计模式的主项目验证

本节知识不需要再合并成一个大程序。加入主项目时，按下面四个独立验证点进行：

1. **容器检查**：需要连续内存的位置使用 `vector`；名称查找根据是否需要顺序选择 `map`或 `unordered_map`；只保存唯一键时使用 `set`或 `unordered_set`。长期保存元素地址前必须写明哪些操作会使其失效。
2. **循环队列**：先使用第3.3节的单线程 `CircularQueue<T, Capacity>`确认固定容量、满/空判断、先进先出和下标回绕正确，再在阶段1-5、1-6加入锁、条件变量和关闭状态。
3. **接口对象**：接口基类提供虚析构，派生函数使用 `override`，接口对象由智能指针管理；运行第5.3节Demo确认动态派发和完整析构顺序。
4. **模式选择**：先写出问题是通知、算法替换、对象创建、接口转换还是行为叠加，再选择观察者、策略、工厂、适配器或装饰器。无法指出具体问题时，不添加模式。

三个完整Demo都只依赖C++17标准库：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic vector_invalidation_demo.cpp -o vector_invalidation_demo
g++ -std=c++17 -Wall -Wextra -pedantic circular_queue_demo.cpp -o circular_queue_demo
g++ -std=c++17 -Wall -Wextra -pedantic virtual_dispatch_demo.cpp -o virtual_dispatch_demo
```

最终应能独立回答：

- 为什么 `map`通常表现为有序树，而业务代码却不能依赖它一定是红黑树？
- `unordered_map`为什么平均查找快，什么时候会重新哈希？
- `vector`扩容后为什么不能继续使用旧元素地址？
- `CircularQueue<int, 3>`中的类型参数、非类型参数和具体类型分别是什么？
- 循环队列怎样区分“读写下标相同但队列为空”和“读写下标相同但队列已满”？
- 通过 `IProcessor*`删除派生对象时为什么必须有虚析构？
- vtable和vptr是C++标准规定，还是主流编译器的常见实现？
- 当前模块问题属于通知、算法替换、对象创建、接口转换还是附加行为？
- 如果普通组合已经足够，为什么不应再制造一层设计模式？
