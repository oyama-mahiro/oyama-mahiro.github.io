---
title: '[嵌入式AI-C++工程] 智能指针'
published: 2026-09-24T08:01:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍智能指针的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-2 智能指针

C++ 智能指针是定义在 `<memory>` 头文件中的资源管理类型。它们用资源获取即初始化（Resource Acquisition Is Initialization，RAII）把动态对象的所有权与智能指针自身的生命周期绑定起来。RAII、对象生命周期和所有权已经在阶段 1-1 第 5～7 节讲过，本节重点是如何用标准库类型表达这些关系。

智能指针并不是“永远不会出错的指针”。它主要解决谁负责释放资源的问题；如果所有权模型本身选错、观察指针越过资源生命周期，或者多个线程无锁修改同一对象，程序仍然可能出错。

## 1 C++智能指针与所有权类型选择

### 1.1 智能指针与RAII的关系

智能指针本身是一个普通 C++ 对象。它内部保存被管理对象的地址，并在自己的析构函数中按照既定策略释放资源：

```text
智能指针构造或接管资源
        ↓
智能指针在作用域内持有所有权
        ↓
智能指针移动、复制或被重置
        ↓
最后一个有效拥有者析构
        ↓
调用 delete 或自定义删除器
```

因此，正常返回、提前 `return` 和异常栈展开都能触发智能指针析构，资源不需要在每条退出路径上手工释放。

需要区分两个对象：

- **智能指针对象**：例如局部变量 `owner`，它有自己的作用域和生命周期。
- **被管理对象**：例如动态创建的 `Task`，它的生命周期由所有权关系决定。

智能指针销毁后，从 `get()` 取得的裸指针不会自动变成 `nullptr`。裸指针可能仍保存原地址，但被管理对象已经不存在，此时它就是悬空观察者。

### 1.2 唯一所有权、共享所有权与非拥有型观察关系

选择智能指针前，先判断实际所有权：

| 所有权关系 | 标准库表达 | 核心语义 |
| --- | --- | --- |
| 唯一所有权 | `std::unique_ptr<T>` | 同一资源只有一个负责释放的拥有者，所有权可以移动 |
| 共享所有权 | `std::shared_ptr<T>` | 多个拥有者共同延长对象生命周期，最后一个拥有者负责释放 |
| 非拥有型观察 | `std::weak_ptr<T>` | 观察由 `shared_ptr` 管理的对象，但不延长其生命周期 |
| 临时借用 | `T&`、`const T&` 或 `T*` | 调用期间访问对象，不接管释放责任 |

实际选择顺序是：

1. 如果对象可以直接作为值或成员存在，优先不用动态分配。
2. 必须动态分配时，优先考虑唯一所有权。
3. 只有多个组件确实需要共同决定对象何时销毁时，才使用共享所有权。
4. 只需要查看共享对象时，使用 `weak_ptr` 或生命周期明确的借用接口。

“不知道由谁释放，所以使用 `shared_ptr`”不是共享所有权需求，而是尚未完成生命周期设计。

## 2 `std::unique_ptr`的创建、移动与资源释放

`std::unique_ptr<T>` 是标准库中的独占所有权智能指针。它不能复制，但可以移动。不能复制的目的，是防止两个普通对象同时认为自己是同一资源的唯一拥有者。

### 2.1 `std::make_unique`与唯一所有权转移

创建普通 C++ 动态对象时，优先使用 `std::make_unique`：

```cpp
#include <memory>
#include <string>
#include <utility>

struct Task {
    std::string name;
};

std::unique_ptr<Task> create_task()
{
    // make_unique 完成对象分配，并立即把唯一所有权放入 unique_ptr。
    return std::make_unique<Task>(Task{"decode"});
}

void consume_task(std::unique_ptr<Task> task)
{
    // 按值接收 unique_ptr，表示本函数取得所有权。
    task->name = "finished";
}

int main()
{
    auto task = create_task();
    consume_task(std::move(task));

    // 移动后 task 不再拥有原对象，通常应只做判空、析构或重新赋值。
    if (!task) {
        // 所有权已经进入 consume_task，并在该函数结束时释放。
    }
}
```

`std::move` 本身不搬运对象，也不修改所有权。它把表达式转换为可被移动操作接收的形式，真正的所有权转移由 `unique_ptr` 的移动构造或移动赋值完成。

函数返回局部 `unique_ptr` 时通常直接 `return pointer;`，不需要手工写 `std::move(pointer)`。返回值机制能够完成所有权交付，并允许编译器进行返回值优化。

### 2.2 `get`、`reset`与`release`的区别

这三个成员函数都与内部地址有关，但所有权效果完全不同：

| 操作 | 返回或结果 | 是否释放当前资源 | 典型用途 |
| --- | --- | --- | --- |
| `get()` | 返回内部裸指针 | 否 | 临时调用只接受裸指针的接口 |
| `reset()` | 接管新地址或变为空 | 是 | 主动结束当前资源、替换资源 |
| `release()` | 返回内部裸指针并放弃所有权 | 否 | 把释放责任交给另一个明确的资源管理接口 |

```cpp
auto owner = std::make_unique<Task>(Task{"decode"});

Task* observer = owner.get(); // observer 只借用，不负责 delete。
observer->name = "infer";

owner.reset();                // 销毁 Task，owner 变为空。
// observer 现在成为悬空指针，不能继续解引用。
```

`release()` 最容易被误用：

```cpp
Task* raw = owner.release();
// owner 已经变为空，但 raw 指向的对象仍然存在。
// 从这一行开始，调用者必须明确把 raw 交给新的拥有者，或最终 delete raw。
```

如果返回值被忽略，释放责任就会丢失：

```cpp
owner.release(); // 错误示例：对象没有被释放，地址也丢失，造成泄漏。
```

### 2.3 自定义删除器与C接口资源管理

`unique_ptr` 默认用 `delete` 释放对象，但 C 接口、文件和设备句柄常要求调用专用函数。此时可以使用 `std::unique_ptr<T, Deleter>` 配置**自定义删除器（custom deleter）**。

先拆开这个类型的写法：

```cpp
std::unique_ptr<CHandle, HandleDeleter>
//              资源类型      删除器类型
```

尖括号中的两项是 `unique_ptr` 的**模板参数**：

| 部分 | 类型 | 作用 |
| --- | --- | --- |
| `std::unique_ptr` | 类模板 | 提供唯一所有权和自动释放能力 |
| `CHandle` | 第一个模板参数 | 表示被管理的资源类型，内部通常保存 `CHandle*` |
| `HandleDeleter` | 第二个模板参数 | 表示释放资源时要使用哪一种删除器 |

`HandleDeleter` 填的是一个**类型**，不是一次函数调用。这个类型必须能够接收 `CHandle*` 并完成释放：

```cpp
struct HandleDeleter {
    void operator()(CHandle* handle) const noexcept
    {
        destroy_handle(handle);
    }
};
```

`operator()` 让 `HandleDeleter` 对象可以像函数一样被调用。需要释放资源时，`unique_ptr` 执行的动作可以理解为：

```cpp
HandleDeleter deleter;
deleter(handle); // 最终调用 destroy_handle(handle)。
```

完整类型较长，因此可以在解释完整类型后再定义别名：

```cpp
using UniqueHandle = std::unique_ptr<CHandle, HandleDeleter>;
```

这里还要区分**模板参数**和**构造参数**：

```cpp
// CHandle 和 HandleDeleter 是模板参数，用来确定智能指针的类型。
using UniqueHandle = std::unique_ptr<CHandle, HandleDeleter>;

// create_handle(42) 返回 CHandle*，它是构造 UniqueHandle 时传入的实际资源。
UniqueHandle handle{create_handle(42)};
```

本例的 `HandleDeleter` 没有成员变量，可以被自动创建，所以构造 `handle` 时只需要传入资源地址。如果删除器还保存额外状态，也可以显式传入删除器对象：

```cpp
UniqueHandle handle{create_handle(42), HandleDeleter{}};
//                  实际资源地址       实际删除器对象
```

`UniqueHandle` 析构、`reset()` 或被移动赋值覆盖时，只要内部地址非空，就会调用保存的删除器对象。这样，释放规则和资源所有权一起保存在智能指针中。

需要遵守创建和释放配对：

- `new` 对应 `delete`。
- `new[]` 对应 `delete[]`。
- `fopen` 对应 `fclose`。
- 第三方 `create_xxx` 对应其文档指定的 `destroy_xxx`。

带自定义删除器的 `unique_ptr` 类型与普通 `unique_ptr<T>` 不同。设计函数参数和返回类型时，应通过类型别名统一表达删除策略。

## 3 `std::shared_ptr`的引用计数与控制块

`std::shared_ptr<T>` 是标准库中的共享所有权智能指针。多个 `shared_ptr` 可以共同拥有同一个对象，最后一个共享拥有者消失时才销毁对象。

### 3.1 `std::make_shared`与共享所有权

普通 C++ 对象从创建时就需要共享所有权时，优先使用 `std::make_shared`：

```cpp
#include <memory>

auto first_owner = std::make_shared<Task>(Task{"decode"});
auto second_owner = first_owner; // 复制 shared_ptr，新增一个共享拥有者。

first_owner.reset();              // 对象仍由 second_owner 拥有，不会销毁。
second_owner.reset();             // 最后一个拥有者离开，对象在这里销毁。
```

`make_shared` 通常用一次组合分配保存对象和控制信息，代码也不会暴露尚未被智能指针接管的裸地址。需要专用释放函数的 C 资源则应直接构造带删除器的智能指针，不能机械套用普通 `make_shared`。

### 3.2 强引用计数、对象销毁与控制块销毁

复制一个已有的 `shared_ptr` 后，新旧两个 `shared_ptr` 会共同管理同一个对象。程序会记录当前还有多少个 `shared_ptr` 负责保持这个对象存活；当这个数量降为零时，对象才会销毁。

标准库把这份共享管理信息放在一个**控制块（control block）**中。控制块通常记录：

- 强引用计数：当前有多少个 `shared_ptr` 共同拥有对象。
- 弱引用相关状态：是否仍有 `weak_ptr` 观察这个控制块。
- 删除器：对象最终应该如何释放。

```text
first_owner ─┐
             ├──> 控制块 ───> Task对象
second_owner ┘    强引用计数=2
```

生命周期分成两步：

1. 强引用计数降为零：被管理对象销毁。
2. 强引用和弱引用都消失：控制块释放。

`use_count()` 可以在学习和诊断中观察强引用数量，但不应在并发业务中用“先读取计数，再决定操作”的方式保证安全。读取结束后，其他线程可能立即改变计数。

### 3.3 多控制块、重复释放与线程安全边界

同一个裸指针只能交给一个 `shared_ptr` 接管，不能再次使用这个裸指针创建另一个 `shared_ptr`，否则同一对象会被释放两次：

```cpp
Task* raw = new Task{"decode"};

std::shared_ptr<Task> owner_a{raw};
std::shared_ptr<Task> owner_b{raw}; // 错误：第二个独立控制块也认为自己负责 delete raw。
```

`owner_a` 和 `owner_b` 是分别从裸指针创建的，彼此不知道对方也在管理这个对象。二者各自记录一份引用计数，而且各自的计数都是 1。这两份彼此独立的管理信息就是两个不同的控制块。

`owner_a` 析构时会删除 `raw`，`owner_b` 析构时还会再次删除同一地址，因此发生重复释放。正确做法是只让一个 `shared_ptr` 接管裸指针，其他拥有者复制这个已有的 `shared_ptr`：

```cpp
auto owner_a = std::make_shared<Task>(Task{"decode"});
auto owner_b = owner_a; // 共享同一个控制块。
```

还要区分两个并发问题：

- 不同 `shared_ptr` 实例共同维护同一个控制块时，引用计数管理可以支持并发操作。
- 被管理的 `Task` 对象不会因为外层使用 `shared_ptr` 就自动线程安全。多个线程同时修改 `Task` 仍可能形成数据竞争，需要锁、不可变设计或其他同步机制。

因此，“用 `shared_ptr` 包起来”只能回答对象是否存活，不能回答对象能否被多个线程同时修改。

## 4 `std::weak_ptr`与循环引用

`std::weak_ptr<T>` 是对共享对象的非拥有型观察指针。它关联 `shared_ptr` 的控制块，但不增加强引用计数，因此不会阻止对象销毁。

### 4.1 使用`lock`安全访问共享对象

`weak_ptr` 不能直接使用 `->` 解引用。访问前调用 `lock()`：

```cpp
std::weak_ptr<Task> observer;

{
    auto owner = std::make_shared<Task>(Task{"decode"});
    observer = owner;

    if (auto temporary_owner = observer.lock()) {
        // lock 成功后获得一个 shared_ptr。
        // 在 temporary_owner 的作用域内，Task 会保持存活。
        temporary_owner->name = "infer";
    }
}

if (auto temporary_owner = observer.lock()) {
    // 对象仍然存在时进入这里。
} else {
    // 原 shared_ptr 已全部销毁，lock 返回空 shared_ptr。
}
```

`expired()` 可以查询观察对象是否已经销毁，但在并发环境中，“先 `expired()`，再做另一项操作”之间仍可能发生状态变化。需要实际访问对象时，直接检查 `lock()` 的返回值更可靠，因为成功获得的临时 `shared_ptr` 会在使用期间延长对象生命周期。

### 4.2 双向`std::shared_ptr`循环引用的形成

如果两个对象都使用 `shared_ptr` 拥有对方，就会形成循环引用：

```text
外部 left ──> Left ──shared_ptr──> Right
                          ↑          │
                          └shared_ptr┘
```

外部的 `left` 和 `right` 即使都离开作用域，`Left` 仍由 `Right` 内部的 `shared_ptr` 拥有，`Right` 也仍由 `Left` 拥有。双方强引用计数都无法降为零，析构函数不会执行。

这类问题不仅泄漏两个小对象。若节点还拥有图像缓冲区、线程、文件或设备资源，整个资源子图都会被保留。长期运行的服务会不断积累这些资源。

### 4.3 使用`std::weak_ptr`解除循环引用

解除循环的关键不是随意把一边换成 `weak_ptr`，而是识别哪一条关系不负责让对方继续存活。

例如，父对象拥有子对象，子对象只需要在父对象仍然存在时回看父对象：

```text
Parent ──shared_ptr拥有──> Child
Parent <──weak_ptr观察──── Child
```

父到子是所有权关系，子到父是观察关系。外部父拥有者离开后，父对象开始销毁，父持有的子对象也随之销毁；弱引用不会阻止这条释放链。

回调也可能形成不明显的环：对象拥有回调，回调的 lambda 又按值捕获指向该对象的 `shared_ptr`。修复时可以捕获 `weak_ptr`，执行回调时再调用 `lock()`，同时处理对象已经销毁的情况。

## 5 函数接口中的所有权表达与常见误用

### 5.1 使用指针和引用表达临时借用

函数只在调用期间访问对象，不需要延长其生命周期时，通常使用引用或裸指针：

```cpp
void inspect_task(const Task& task); // 必须存在，只读借用。
void update_task(Task& task);        // 必须存在，可修改借用。
void try_update_task(Task* task);    // 可以为空，可修改借用。
```

借用接口不负责释放，也不应在没有额外约定时把地址保存到调用结束之后。使用裸指针表达借用并不等于泄漏；是否泄漏取决于资源拥有者是否仍然明确。

如果函数只需要访问 `shared_ptr` 指向的对象，也不一定要接收 `shared_ptr`。接收 `const Task&` 能更直接地表达“调用期间借用，不参与共享所有权”。

### 5.2 使用智能指针表达所有权转移与共享

接口中的智能指针类型应表达生命周期行为：

```cpp
// 工厂创建对象，并把唯一所有权交给调用者。
std::unique_ptr<Task> create_task();

// 按值接收 unique_ptr：调用者必须移动传入，函数取得唯一所有权。
void submit_task(std::unique_ptr<Task> task);

// 按值接收 shared_ptr：函数或其保存位置将新增一份共享所有权。
void register_task(std::shared_ptr<Task> task);
```

如果参数是 `const std::shared_ptr<Task>&`，函数只是借用这个智能指针对象，不会因为参数绑定本身增加引用计数。此时需要问：函数真正需要的是共享所有权信息，还是只需要 `Task&`。接口应选择更准确的语义，而不是一律传智能指针。

### 5.3 `shared_ptr(this)`、`release`与悬空观察者风险

下面这些写法会让释放责任重复、丢失或变得不明确：

1. **`shared_ptr(this)`**：如果当前对象已经由一个 `shared_ptr` 管理，再用 `this` 创建新的 `shared_ptr`，新指针并不知道已有拥有者的存在。两个 `shared_ptr` 最后会分别释放同一对象。它们各自保存的独立管理信息称为两个控制块。确实需要从成员函数取得共享所有权时，应了解 `std::enable_shared_from_this`，但前提是对象从一开始就由正确的 `shared_ptr` 管理。
2. **滥用 `release()`**：`unique_ptr` 放弃所有权却不释放对象，调用者又没有立即建立新的所有权，形成泄漏。
3. **长期保存 `get()` 的结果**：智能指针被重置、移动或销毁后，旧裸指针成为悬空观察者。
4. **所有对象都用 `shared_ptr`**：销毁时机变得难以推理，并更容易通过双向关系或回调形成环。
5. **错误删除器**：资源由 C 接口创建，却交给普通 `delete`；或者删除器依赖一个已经销毁的外部对象。

选择类型时可以使用下面的判断顺序：值对象优先，其次是 `unique_ptr`；只有真实共享生命周期才使用 `shared_ptr`；只观察共享对象时使用 `weak_ptr`；调用期间的普通借用则使用引用或裸指针。

## 6 自定义删除器与循环引用验证Demo

本节使用三个彼此独立的 C++17 小 Demo。每个 Demo 只回答一个问题，保存、编译后直接运行，不需要命令行参数或模式选择：

1. 自定义删除器能否自动调用 C 接口的专用释放函数。
2. 双向 `shared_ptr` 为什么会让两个对象都无法析构。
3. 把反向关系改成 `weak_ptr` 后，对象能否正常析构。

三个 Demo 都只依赖 C++ 标准库，不需要 OpenCV、FFmpeg 或设备环境。

### 6.1 模拟C接口句柄的自动释放验证

**这个 Demo 只验证一个知识点：** `unique_ptr` 可以通过自定义删除器，在离开作用域时自动调用资源对应的 C 接口释放函数。

阅读代码前需要的知识都已经在前文说明：

- `unique_ptr` 的唯一所有权和作用域释放：本篇第 2 节，以及阶段 1-1 第 5 节。
- `std::unique_ptr<CHandle, HandleDeleter>` 的两个模板参数：本篇第 2.3 节。
- `using UniqueHandle = ...` 隐藏的完整类型：本篇第 2.3 节。
- `noexcept` 表示函数不会向外抛出异常：阶段 1-1 第 3.2 节。

Demo 信息：

- 源文件：`custom_deleter_demo.cpp`
- 输入：无。
- 输出：句柄创建、使用和销毁日志。
- 验收：业务代码不手工调用 `destroy_handle()`，但销毁日志仍恰好出现一次。

```cpp
#include <iostream>
#include <memory>

// 模拟由 C 接口返回的外部资源。
// 调用者不能随意 delete，而要使用接口规定的 destroy_handle()。
struct CHandle {
    int id{};
};

CHandle* create_handle(int id)
{
    std::cout << "create handle: " << id << '\n';
    return new CHandle{id};
}

void destroy_handle(CHandle* handle) noexcept
{
    if (handle == nullptr) {
        return;
    }

    std::cout << "destroy handle: " << handle->id << '\n';
    delete handle;
}

// 删除器把 unique_ptr 的默认释放动作替换为 destroy_handle()。
struct HandleDeleter {
    void operator()(CHandle* handle) const noexcept
    {
        destroy_handle(handle);
    }
};

// 完整类型已在第 2.3 节拆解，这里用别名缩短后续代码。
using UniqueHandle = std::unique_ptr<CHandle, HandleDeleter>;

int main()
{
    {
        // create_handle() 返回 CHandle*。
        // UniqueHandle 立即接管它，并成为唯一负责释放该句柄的对象。
        UniqueHandle handle{create_handle(42)};

        std::cout << "use handle: " << handle->id << '\n';

        // 离开花括号时，handle 析构并调用 HandleDeleter。
        // 业务代码不需要在这里手工调用 destroy_handle()。
    }

    std::cout << "scope finished\n";
}
```

Linux 编译与运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -g \
    custom_deleter_demo.cpp -o custom_deleter_demo

./custom_deleter_demo
```

预期输出：

```text
create handle: 42
use handle: 42
destroy handle: 42
scope finished
```

`destroy handle` 出现在 `scope finished` 之前，证明 `UniqueHandle` 离开作用域时调用了自定义删除器。这个 Demo 不再混入内存分配失败、提前返回或异常测试，因为它们不是本 Demo 要讲的知识点。

### 6.2 `std::shared_ptr`循环引用与`std::weak_ptr`解环验证

这里拆成两个独立 Demo。第一个只制造循环引用，第二个只展示 `weak_ptr` 修复后的所有权关系。

**小 Demo A：双向 `shared_ptr` 为什么阻止析构**

阅读代码前需要的知识：

- `make_shared` 创建共享对象：本篇第 3.1 节。
- `use_count()` 观察强引用数量：本篇第 3.2 节。
- `weak_ptr::expired()` 判断观察对象是否已经销毁：本篇第 4.1 节。
- 双向 `shared_ptr` 形成循环的原因：本篇第 4.2 节。

`observer` 只是验证工具。它使用 `weak_ptr` 观察 `left`，不会增加强引用计数，也不会影响循环引用是否发生。

Demo 信息：

- 源文件：`shared_cycle_demo.cpp`
- 输入：无。
- 输出：两个对象的引用计数，以及外部拥有者离开后对象是否仍然存活。
- 验收：两个外部 `shared_ptr` 离开作用域后，`observer` 仍能确认对象没有销毁，且没有析构日志。

```cpp
#include <iostream>
#include <memory>
#include <string>

struct Node {
    std::string name;

    // partner 是 shared_ptr，表示当前节点负责让对方继续存活。
    std::shared_ptr<Node> partner;

    ~Node()
    {
        std::cout << "destroy: " << name << '\n';
    }
};

int main()
{
    // observer 只观察 left，不会让 left 的强引用计数增加。
    std::weak_ptr<Node> observer;

    {
        auto left = std::make_shared<Node>();
        auto right = std::make_shared<Node>();

        left->name = "left";
        right->name = "right";
        observer = left;

        // left 拥有 right，right 也拥有 left，形成强引用环。
        left->partner = right;
        right->partner = left;

        std::cout << "left use_count: " << left.use_count() << '\n';
        std::cout << "right use_count: " << right.use_count() << '\n';
    }

    // 外部的 left 和 right 已经销毁。
    // 如果没有循环，observer 此时应该已经过期。
    if (observer.expired()) {
        std::cout << "object destroyed\n";
    } else {
        std::cout << "object still alive\n";
    }
}
```

Linux 编译与运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -g \
    shared_cycle_demo.cpp -o shared_cycle_demo

./shared_cycle_demo
```

预期关键输出：

```text
left use_count: 2
right use_count: 2
object still alive
```

没有出现 `destroy: left` 或 `destroy: right`，并且弱观察者确认对象仍然存在。这两项证据共同说明：外部拥有者已经离开，但两个节点仍通过内部的 `shared_ptr` 互相保持存活。

**小 Demo B：用 `weak_ptr` 表达不负责延长生命周期的反向关系**

阅读代码前需要的知识：

- `make_shared` 和共享对象：本篇第 3.1 节。
- `weak_ptr` 不增加强引用计数：本篇第 4 节。
- `lock()` 获得临时 `shared_ptr`：本篇第 4.1 节。
- 父拥有子、子观察父的关系：本篇第 4.3 节。

Demo 信息：

- 源文件：`weak_ptr_demo.cpp`
- 输入：无。
- 输出：子节点观察父节点的结果、析构日志以及外部观察者状态。
- 验收：父对象存活时 `lock()` 成功；离开作用域后两个节点都析构，外部观察者确认父对象已经销毁。

```cpp
#include <iostream>
#include <memory>
#include <string>

struct Node {
    std::string name;

    // 父节点负责让子节点存活。
    std::shared_ptr<Node> child;

    // 子节点只观察父节点，不负责让父节点继续存活。
    std::weak_ptr<Node> parent;

    void print_parent() const
    {
        // lock() 成功后得到临时 shared_ptr。
        // 在 temporary_parent 的作用域内，父节点一定仍然有效。
        if (auto temporary_parent = parent.lock()) {
            std::cout << name << " observes "
                      << temporary_parent->name << '\n';
        } else {
            std::cout << name << " observes expired parent\n";
        }
    }

    ~Node()
    {
        std::cout << "destroy: " << name << '\n';
    }
};

int main()
{
    std::weak_ptr<Node> outside_observer;

    {
        auto parent = std::make_shared<Node>();
        auto child = std::make_shared<Node>();

        parent->name = "parent";
        child->name = "child";

        parent->child = child;  // 强拥有：parent -> child
        child->parent = parent; // 弱观察：child -> parent
        outside_observer = parent;

        child->print_parent();
    }

    // weak_ptr 不会阻止对象析构。
    if (outside_observer.expired()) {
        std::cout << "parent destroyed\n";
    } else {
        std::cout << "parent still alive\n";
    }
}
```

Linux 编译与运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -g \
    weak_ptr_demo.cpp -o weak_ptr_demo

./weak_ptr_demo
```

预期关键输出：

```text
child observes parent
destroy: parent
destroy: child
parent destroyed
```

`parent -> child` 使用 `shared_ptr`，所以父节点负责让子节点存活；`child -> parent` 使用 `weak_ptr`，所以子节点不会反过来阻止父节点析构。

### 6.3 Demo运行结果与所有权关系验收

三个小 Demo 分别对应三张简单关系图：

```text
自定义删除器：

UniqueHandle ──唯一拥有──> CHandle
      │
      └─析构时调用 HandleDeleter -> destroy_handle
```

```text
循环引用：

Left ──shared_ptr拥有──> Right
Left <──shared_ptr拥有── Right

结果：双方都无法析构
```

```text
weak_ptr 解环：

Parent ──shared_ptr拥有──> Child
Parent <──weak_ptr观察──── Child

结果：外部拥有者离开后，Parent 和 Child 都正常析构
```

完成本节后，逐项检查：

- 能逐项解释 `std::unique_ptr<CHandle, HandleDeleter>` 中的资源类型和删除器类型。
- 能区分智能指针的模板参数与创建对象时传入的构造参数。
- 能说明智能指针解决的是所有权和释放责任，而不是所有指针安全问题。
- 会用 `make_unique` 创建对象，并用 `std::move` 转移唯一所有权。
- 能区分 `get()`、`reset()` 和 `release()` 对所有权的影响。
- 能解释 `shared_ptr` 的引用计数和对象销毁时机。
- 知道同一个裸指针只能交给一个 `shared_ptr` 接管，其他共享拥有者必须复制已有的 `shared_ptr`。
- 能用 `weak_ptr::lock()` 安全访问共享对象。
- 能识别双向 `shared_ptr` 或回调捕获形成的循环引用。
- 能为 C 接口资源配置与创建接口匹配的自定义删除器。
- 能根据借用、转移、共享和观察关系选择函数参数类型。
- 能解释引用计数的并发维护不等于被管理对象线程安全。
