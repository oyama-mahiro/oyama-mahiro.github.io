---
title: '[嵌入式AI-C++工程] 多线程、锁和条件变量'
published: 2026-09-24T08:04:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍多线程、锁和条件变量的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-5 多线程、锁和条件变量

多线程允许同一个进程中的多个执行流并发工作。线程共享进程中的大部分内存，因此传递数据方便，但只要多个线程无同步地访问同一对象，就可能产生数据竞争、错误结果或死锁。本节先建立线程、互斥锁和条件变量的正确使用规则，再通过五个相互独立的小Demo验证故障与修复。

对象生命周期见阶段1-1，共享对象并不会因为使用 `shared_ptr`就自动线程安全，见阶段1-2第3.3节。阶段1-4第3节的循环队列目前是单线程实现，本节学习的锁和条件变量将在阶段1-6用于实现有限队列与安全退出。

## 1 `std::thread`的创建、参数传递与生命周期

### 1.1 线程共享内存与并发执行顺序

进程是操作系统分配资源和隔离地址空间的重要单位；线程是进程内部的一条执行流。同一进程中的线程通常共享：

- 动态分配的堆内存。
- 全局对象和静态对象。
- 文件描述符等进程资源。

每个线程则有自己的调用栈、当前执行位置和部分线程局部状态。

创建线程后，主线程和工作线程谁先执行没有固定保证：

```cpp
void work() {
    std::cout << "worker\n";
}

int main() {
    std::thread worker(work);
    std::cout << "main\n";
    worker.join();
}
```

输出可能先出现 `main`，也可能先出现 `worker`。代码不能依赖某一次运行观察到的先后顺序。若执行顺序影响正确性，必须使用锁、条件变量、原子操作或其他同步机制明确表达关系。

### 1.2 `std::thread`、`join()`、`detach()`与`joinable()`

`std::thread`定义在 `<thread>`头文件中，表示一个线程句柄。最常见的创建方式是把函数和参数交给构造函数：

```cpp
std::thread worker(process_frame, frame_id);
```

这里：

- `worker`是线程对象。
- `process_frame`是新线程要执行的函数。
- `frame_id`是传给函数的参数。
- 构造成功后，新线程可以立即开始执行。

`join()`阻塞当前线程，直到目标线程执行结束：

```cpp
worker.join();
```

`joinable()`返回布尔值，表示线程对象当前是否关联着一个仍需要 `join()`或 `detach()`的执行线程：

```cpp
if (worker.joinable()) {
    worker.join();
}
```

同一个线程不能 `join()`两次。`join()`返回后，`joinable()`变为 `false`。

如果一个仍然 `joinable()`的 `std::thread`对象进入析构函数，程序会调用 `std::terminate()`，不是自动等待线程结束。因此，创建线程后必须为所有退出路径安排 `join()`或 `detach()`，不能什么都不做。

`detach()`的基本语法是：

```cpp
void background_task();

std::thread worker(background_task);
worker.detach();
```

`detach()`把工作线程与当前 `std::thread`对象解除关联。调用后：

- 工作线程继续独立运行，不会因为 `worker`对象析构就自动停止。
- `worker.joinable()`变为 `false`。
- 不能再通过 `worker.join()`等待该线程。
- 不能再通过这个 `std::thread`对象判断工作线程是否已经完成。

所以 `detach()`不是“后台运行并且自动安全管理”，它只是表示：**从现在开始，这个 `std::thread`对象不再负责等待该线程**。

`join()`与 `detach()`的直接区别是：

| 操作 | 工作线程是否继续运行 | 当前线程能否等待结果 | `std::thread`对象之后是否`joinable` |
|---|---:|---:|---:|
| `join()` | 继续运行，当前线程等待它结束 | 能，`join()`返回表示已经结束 | 否 |
| `detach()` | 独立继续运行，调用者不等待 | 不能再通过原线程对象等待 | 否 |

`detach()`最大的风险是对象生命周期。下面的代码是错误示例：

代码中的 `std::string`是标准库字符串类型，需要 `<string>`头文件；Lambda捕获列表 `[&message]`表示在线程函数中保存并使用原变量 `message`的引用，而不是保存字符串副本。`use_message`只声明一个读取字符串的函数，用来表示分离线程稍后会访问该变量。

```cpp
void use_message(const std::string& message);

void launch_bad_task() {
    std::string message = "frame ready";

    std::thread worker([&message] {
        // 工作线程保存的是对局部message的引用。
        use_message(message);
    });

    worker.detach();
} // 函数返回后message销毁，但分离线程可能还在使用它
```

`launch_bad_task()`返回后，局部字符串 `message`被销毁；分离线程若随后访问它，就会使用悬空引用。`detach()`不会自动复制引用指向的对象，也不会延长局部变量生命周期。

即使线程只使用自己保存的参数副本，还要考虑进程生命周期：主程序退出时，整个进程结束，分离线程不会获得“必须执行完成”的保证。尚未写完的日志、文件或网络数据可能来不及处理。

只有同时满足以下条件时，才考虑 `detach()`：

- 调用方确实不需要等待完成，也不需要取得线程返回结果。
- 线程使用的数据拥有独立且明确的生命周期，不引用即将销毁的局部对象或外层 `this`对象。
- 线程失败和进程退出时任务未完成的处理方式已经明确。
- 线程停止由其他机制管理，或者任务确实允许运行到进程结束。

普通业务任务、相机采集线程、推理工作线程和需要安全关闭的后台服务通常更适合保存线程对象、发出停止请求并 `join()`。大量短任务更适合交给线程池，而不是为每个任务创建一个分离线程。

### 1.3 线程参数复制、引用传递与对象生命周期

`std::thread`默认把函数和参数保存到自己的内部状态中，普通参数通常按值复制或移动：

```cpp
void process(int frame_id);

int frame_id = 7;
std::thread worker(process, frame_id);
```

工作线程使用的是保存下来的参数，不要求原变量 `frame_id`始终存在。

若线程函数明确接收引用，需要使用 `std::ref`包装变量：

```cpp
void update(int& value);

int value = 0;
std::thread worker(update, std::ref(value));
worker.join();
```

`std::ref(value)`定义在 `<functional>`中，它创建一个引用包装对象，使 `std::thread`最终把原变量作为引用传给函数。此时必须保证 `value`活到工作线程最后一次访问之后。

Lambda表达式按引用捕获也有相同风险：

```cpp
std::thread worker([&value] {
    value = 42;
});
```

如果外层函数在工作线程完成前返回，`value`可能已经销毁，线程中的引用就会悬空。正确顺序通常是：共享状态先构造，线程随后启动，停止请求发出后完成 `join()`，最后才销毁共享状态。

## 2 C++数据竞争与线程同步关系

### 2.1 数据竞争的严格判断条件

判断C++数据竞争（data race）时，不要只看结果是否正确。两个可能并发执行的操作同时满足以下条件，就可能形成数据竞争：

1. 它们访问同一个内存位置。
2. 至少一个操作会写入。
3. 两个访问之间没有由锁、原子操作等机制建立的正确同步关系。
4. 这些访问不是全部通过满足要求的原子操作完成。

例如两个线程同时执行：

```cpp
++counter;
```

普通整数递增可以近似理解成三个步骤：

```text
读取counter旧值
计算旧值加1
把新值写回counter
```

两个线程可能都读取到100，都计算出101，再都写回101。虽然执行了两次递增，结果只增加1。更重要的是，这种无同步冲突访问在C++中属于未定义行为，不能把它只当成“偶尔少算一次”。

以下情况不构成上述普通数据竞争：

- 两个线程只读取同一个在此期间不变化的对象。
- 所有冲突访问都由同一把互斥锁正确保护。
- 对单一原子对象执行符合要求的原子操作。

### 2.2 数据竞争、CPU缓存一致性与伪共享的区别

数据竞争确实可能通过CPU缓存表现出来，例如一个核心暂时没有观察到另一个核心的写入。但是，**数据竞争不是由CPU缓存定义的，CPU缓存也不是产生数据竞争的必要条件**。

以两个线程同时修改普通整数为例：

```cpp
int count = 0;

// 线程A执行
count += 1;

// 线程B执行
count += 2;
```

`count += n`通常要经历“读取旧值、计算新值、写回新值”。下面的执行顺序会丢失一次更新：

| 执行顺序 | 线程A | 线程B |
|---|---|---|
| 1 | 读取`count == 0` | |
| 2 | | 读取`count == 0` |
| 3 | 计算出1 | |
| 4 | | 计算出2 |
| 5 | 写入1 | |
| 6 | | 写入2 |

最终值是2，而不是3。即使计算机只有一个CPU核心，两个线程也可能因为时间片切换形成这种交错顺序。因此，问题的根本原因是两个线程没有同步地读写同一个对象，而不只是“两个核心的缓存不同”。

在C++中，两个线程访问同一个内存位置、至少一方写入，并且访问之间没有互斥锁或原子操作建立的同步关系，就会产生数据竞争。数据竞争属于程序正确性问题，会导致未定义行为。除了硬件缓存，编译器还可能在缺少同步约束时重排、合并或省略内存访问，所以不能只根据某一种CPU的缓存行为判断程序是否正确。

**CPU为何按缓存行维护数据**

现代CPU缓存通常不按单个字节传输和维护，而是按缓存行（Cache Line）处理。缓存行是CPU缓存与下一级缓存或内存之间交换数据的基本块，常见大小是64字节，但C++标准不保证所有平台都是64字节。

例如循环队列中的两个索引可能在物理内存中相邻：

```text
+------------------------------------------------------------------+
|                    同一条缓存行（例如64字节）                    |
|   head_（8字节）   |   tail_（8字节）   |   其他数据或填充空间   |
+------------------------------------------------------------------+
```

假设生产者在CPU Core 0上频繁写入`head_`，消费者在CPU Core 1上频繁写入`tail_`。虽然两个线程修改的是不同变量，但两个变量位于同一条缓存行，硬件只能按整条缓存行维护它们，不能只让其中8字节失效。

**MESI协议如何维护缓存行一致性**

MESI是一类常见缓存一致性协议名称，四个字母表示一条缓存行可能处于的四种状态：

| 状态 | 英文 | 含义 |
|---|---|---|
| M | Modified | 当前核心已经修改该缓存行，数据与内存中的副本不同 |
| E | Exclusive | 只有当前核心缓存了该行，但尚未修改 |
| S | Shared | 多个核心都可能缓存了相同的只读副本 |
| I | Invalid | 当前缓存中的该行已经失效，不能继续使用 |

不同处理器可能使用MESI的扩展协议，但理解伪共享只需要掌握下面的简化过程：

1. Core 0和Core 1分别读取`head_`与`tail_`，两个变量所在的整条缓存行被加载到各自缓存中。
2. Core 0要写`head_`时，必须先取得这条缓存行的独占修改权。缓存一致性协议通过处理器互连发送失效请求，使其他核心中的同一缓存行失效。
3. 因为`tail_`也在这条缓存行中，所以Core 1手中的`tail_`副本也随整条缓存行一起失效，尽管Core 0根本没有修改`tail_`。
4. Core 1随后访问或修改`tail_`时，必须重新取得有效的缓存行及相应权限。这又可能使Core 0的副本失效。
5. 两个核心不断写入各自变量时，缓存行的所有权就在核心之间反复转移，形成缓存行抖动（Cache Line Bouncing）。

这里说“通过处理器互连发送失效请求”比“向总线广播”更准确，因为现代CPU可能使用总线监听、片上互连或目录式协议，并不一定存在一条所有核心共享的传统总线。

**什么是伪共享**

伪共享（False Sharing）是指：**不同线程修改的是不同变量，逻辑上没有共享同一个变量，但这些变量恰好位于同一条缓存行，导致缓存行在多个核心之间频繁失效和转移。**

因此，伪共享与数据竞争的区别是：

| 对比项 | 数据竞争 | 伪共享 |
|---|---|---|
| 线程访问的对象 | 同一个内存位置 | 不同变量，但位于同一缓存行 |
| 主要后果 | 未定义行为、结果错误 | 程序通常仍正确，但性能下降 |
| 问题层级 | C++并发正确性 | CPU缓存和内存布局性能 |
| 常用解决方法 | 互斥锁、原子操作、重新设计共享状态 | 分离高频写变量，使其位于不同缓存行 |

也就是说，缓存一致性协议并没有失效。它正是为了维护一致性而反复传递缓存行，只是这种传递产生了额外开销。伪共享中的“伪”表示线程看起来在共享数据，实际上只是无关变量共享了同一条物理缓存行。

**C++17如何减少伪共享**

解决伪共享的核心方法是内存对齐和空间填充，使不同线程频繁写入的变量落在不同缓存行中。C++11已经提供`alignas`对齐说明符；C++17又在`<new>`头文件中提供了：

```cpp
std::hardware_destructive_interference_size
```

它是一个编译期常量，表示当前C++实现建议的最小间隔，用于降低两个对象因位于同一缓存行而相互产生破坏性干扰的可能。它通常是64，但不是运行时检测结果，也不能把64当成所有CPU的固定标准。

下面只展示队列索引的内存布局。`std::atomic<std::size_t>`表示对索引进行原子读写，相关使用边界将在本文第5.3节和5.4节说明：

```cpp
#include <atomic>
#include <cstddef>
#include <new>

// 让生产者频繁写入的head单独占据一个合适的对齐区域。
struct alignas(std::hardware_destructive_interference_size) ProducerIndex {
    std::atomic<std::size_t> head{0};
};

// 让消费者频繁写入的tail从另一个对齐边界开始。
struct alignas(std::hardware_destructive_interference_size) ConsumerIndex {
    std::atomic<std::size_t> tail{0};
};

struct QueueIndexes {
    ProducerIndex producer;
    ConsumerIndex consumer;
};

static_assert(alignof(ProducerIndex) >=
              std::hardware_destructive_interference_size);
static_assert(alignof(ConsumerIndex) >=
              std::hardware_destructive_interference_size);
```

`alignas(...)`要求编译器按括号中的边界放置类型对象。由于结构体的大小必须满足其对齐要求，`producer`和`consumer`会从各自的对齐边界开始，从而降低`head`与`tail`落入同一缓存行的可能。

需要注意：

- 对齐只解决内存布局造成的性能干扰，不能代替`std::atomic`或互斥锁。先保证程序没有数据竞争，再优化伪共享。
- `std::hardware_destructive_interference_size`由标准库实现针对编译目标给出，不是程序启动后查询当前CPU得到的动态值。
- 某些旧编译器或标准库虽然启用了C++17，却可能尚未提供该常量。工程中可以根据目标平台设置经过验证的回退值，但要把它当作平台配置，而不是到处硬编码64。
- 是否真的存在伪共享应通过性能分析工具和对齐前后的吞吐量、缓存未命中等指标验证，不能仅凭变量相邻就断定它是性能瓶颈。

`volatile`同样不能解决数据竞争或伪共享。它主要用于内存映射设备寄存器等需要保留特定读写行为的场景，不提供普通多线程所需的原子性和同步关系，也不会改变两个变量所在的缓存行布局。

排查并发问题时，应按下面的顺序判断：

1. 两个线程是否访问同一个内存位置，并且至少一方写入？
2. 如果是，是否使用互斥锁或原子操作正确同步？先排除数据竞争。
3. 程序结果正确但多核性能异常时，再检查不同线程高频写入的变量是否落在同一缓存行，排查伪共享。
4. C++层面的访问合法后，再根据平台检查DMA缓存维护、设备内存映射等嵌入式问题。

### 2.3 同步关系与未定义行为

同步的目的不只是“同一时刻少运行一个线程”，还要让一个线程在正确的时间观察另一个线程已经完成的写入。

例如，线程A在互斥量保护下写入 `result`并释放锁；线程B随后取得同一把锁再读取 `result`。锁的释放和后续获取建立了同步关系，使读取发生在写入之后。

如果程序存在数据竞争，整个程序行为可能未定义：

- 结果偶尔错误。
- 调试版本正常，优化版本出错。
- 增加日志后问题消失。
- 运行很多次都正常，但换机器或负载后失败。

因此，“我运行了100次没出错”不能证明没有数据竞争。需要用代码规则判断，并使用ThreadSanitizer等工具提供额外证据。

## 3 互斥量与锁守卫

### 3.1 `std::mutex`与临界区

互斥量（mutex）用于保证同一时刻只有一个线程进入受它保护的代码区域，这个区域称为临界区（critical section）。`std::mutex`定义在 `<mutex>`中，常用操作是：

- `lock()`：等待并取得锁。
- `unlock()`：释放当前线程持有的锁。
- `try_lock()`：尝试取得锁，立即返回成功或失败。

不推荐在普通业务代码中分散地手写：

```cpp
data_mutex.lock();
modify_shared_state();
data_mutex.unlock();
```

如果中间提前返回或抛出异常，`unlock()`可能没有执行。更安全的方式是使用RAII锁守卫，让局部对象析构时自动解锁。

互斥量应保护一组明确的数据和不变量。例如，循环队列的槽位、读下标、写下标和元素数量共同描述队列状态，不能只锁住 `size_`而让其他字段无锁变化。

### 3.2 `std::lock_guard`的作用域加锁

基本语法是：

```cpp
std::lock_guard<std::mutex> lock(data_mutex);
```

逐项解释：

- `std::lock_guard`是C++标准库的锁守卫类模板。
- `std::mutex`是模板参数，说明它管理的是哪种互斥量。
- `lock`是当前作用域中的局部守卫对象。
- `data_mutex`是传给构造函数的互斥量对象。

构造 `lock`时取得 `data_mutex`；`lock`离开作用域时析构并释放互斥量。锁守卫不能复制，也不需要手工调用 `unlock()`。

```cpp
void increment() {
    std::lock_guard<std::mutex> lock(counter_mutex);
    ++counter;
} // lock在这里析构，自动解锁
```

只要锁的持有时间与一个清楚的作用域一致，优先使用 `lock_guard`。

### 3.3 `std::unique_lock`的可控加锁

`std::unique_lock<std::mutex>`也是锁管理类模板，但比 `lock_guard`保存更多状态，支持：

- 延迟加锁。
- 提前解锁和再次加锁。
- 移动锁的所有权。
- 与 `condition_variable::wait()`配合。

最常见写法仍然是构造时加锁：

```cpp
std::unique_lock<std::mutex> lock(data_mutex);
```

`unique_lock`中的“unique”表示同一时刻由这个锁对象独占管理对应互斥量的所有权，不是说整个程序只能存在一个 `unique_lock`。

条件变量必须在等待时暂时释放互斥量、醒来后重新取得互斥量，因此需要能够执行解锁和加锁操作的 `unique_lock`，不能用接口更固定的 `lock_guard`替代。

### 3.4 `std::scoped_lock`的多锁管理

需要同时取得多把互斥量时，可以使用C++17的 `std::scoped_lock`：

```cpp
std::scoped_lock lock(left_mutex, right_mutex);
```

这里使用类模板实参推导，编译器根据两个构造参数推导互斥量类型。构造时以避免死锁的方式取得两把锁，离开作用域时全部释放。

它适用于“一段操作必须同时持有多把锁”的场景。它不能修复所有死锁，例如持锁等待另一个线程结束、锁内调用未知回调等问题仍需要重新设计。

### 3.5 锁的保护范围与持锁时间

锁应覆盖共享不变量完成一次合法状态转换所需的全部操作，但不应无意义地覆盖耗时工作。

推荐流程是：

1. 取得锁。
2. 检查和修改共享状态，或把需要的数据取到局部对象。
3. 释放锁。
4. 在锁外执行推理、磁盘写入、网络调用或其他耗时工作。

不要持锁调用无法确认行为的外部回调，因为回调可能再次请求同一把锁，或者长时间阻塞。普通读取也不一定安全：若另一个线程同时写入同一对象，无锁读取同样参与数据竞争。

## 4 条件变量、谓词与虚假唤醒

### 4.1 `std::condition_variable`的等待与通知

条件变量（condition variable）用于让线程等待“某个条件成立”，而不是持续循环检查。`std::condition_variable`定义在 `<condition_variable>`中，常用操作是：

- `wait()`：等待条件变化。
- `notify_one()`：唤醒一个等待线程。
- `notify_all()`：唤醒所有等待线程。

条件变量本身不保存任务，也不保存“已经通知过几次”。真正代表业务状态的是受互斥量保护的共享变量，例如：

```cpp
bool result_ready = false;
int result = 0;
```

生产线程把结果写入后，将 `result_ready`改成 `true`；消费线程等待的条件是 `result_ready == true`。通知只是提醒等待线程重新检查这个条件。

### 4.2 `wait()`释放锁、阻塞和重新加锁的过程

等待前，线程必须先通过 `unique_lock`取得保护共享状态的互斥量：

```cpp
std::unique_lock<std::mutex> lock(result_mutex);
result_condition.wait(lock, [] {
    return result_ready;
});
```

带谓词的 `wait`可以按下面过程理解：

1. 当前线程持有 `result_mutex`，检查 `result_ready`。
2. 如果条件为假，`wait`释放互斥量并让线程阻塞。
3. 生产线程取得同一把锁，修改 `result`和 `result_ready`。
4. 生产线程发出通知。
5. 等待线程醒来后重新取得 `result_mutex`。
6. 再次检查 `result_ready`，条件为真才从 `wait`返回。

`wait`必须在阻塞期间释放锁，否则生产线程永远无法取得同一把锁去改变条件。`wait`返回时，`unique_lock`再次持有锁，读取共享结果是受保护的。

### 4.3 谓词检查与虚假唤醒

谓词（predicate）是返回真假的条件检查。上面的Lambda：

```cpp
[] {
    return result_ready;
}
```

没有捕获外部局部变量，因为示例中的 `result_ready`是全局共享状态。若共享状态是局部变量，则需要在确保生命周期安全的前提下按引用捕获。

等待线程可能在没有收到对应业务通知，或条件仍然为假时从底层等待中醒来，这称为虚假唤醒（spurious wakeup）。因此不能只等待一次就直接使用数据：

```cpp
result_condition.wait(lock); // 醒来不代表result_ready一定为true
```

带谓词的重载会反复检查条件，效果近似：

```cpp
while (!result_ready) {
    result_condition.wait(lock);
}
```

所以正确依据是共享状态，不是“我似乎收到了一次通知”。

### 4.4 共享状态、通知时机与丢失通知

生产线程的基本顺序是：

```cpp
{
    std::lock_guard<std::mutex> lock(result_mutex);
    result = 42;
    result_ready = true;
}
result_condition.notify_one();
```

先在锁内同时更新结果和条件，保证消费线程不会看到“条件已真但结果还没写完”的中间状态。示例在解锁后通知，使被唤醒线程不必立刻再次等待同一把锁。

如果通知发生在线程真正进入等待之前，也不一定会出错。只要生产线程已经把 `result_ready`设为 `true`，消费线程取得锁后第一次检查谓词就会直接通过。这就是为什么条件变量必须配合共享状态。

反过来，如果代码只发通知却没有保存状态：

```cpp
result_condition.notify_one();
```

稍后才开始等待的线程无法知道过去发生过通知，可能一直等待。这种错误常被称为丢失通知，但根本问题是没有使用受锁保护的状态表达事实。

## 5 死锁、原子变量与安全退出

### 5.1 重复加锁、循环等待与跨线程等待

死锁（deadlock）表示一组线程互相等待对方才能提供的条件，所有线程都无法继续。

常见情况包括：

1. 同一线程再次对自己已经持有的普通 `std::mutex`调用 `lock()`。这是对 `std::mutex`的错误使用，常见表现是线程永远等待自己释放锁。
2. 线程A持有 `left`等待 `right`，线程B持有 `right`等待 `left`。
3. 线程A持锁调用 `worker.join()`，而工作线程结束前需要取得同一把锁。
4. 持锁调用回调，回调又进入需要同一把锁的代码。

双锁循环等待可以表示为：

```text
线程A：持有left ──等待──> right
          ▲                  │
          │                  ▼
线程B：等待left <──持有── right
```

增加超时时间只能让程序最终报错，不会自动消除循环依赖。

### 5.2 统一锁顺序与死锁预防

最直接的规则是：所有代码路径都按相同顺序取得多把锁。例如始终先 `left`、后 `right`，不能有另一条路径反过来。

如果必须一次取得多把锁，可以使用：

```cpp
std::scoped_lock lock(left, right);
```

还应遵守：

- 不持锁等待可能需要该锁的线程结束。
- 不持锁执行未知回调或长时间I/O。
- 缩小锁的嵌套层次。
- 在设计文档或成员命名中说明哪把锁保护哪些数据。
- 发生卡死时查看所有线程栈，寻找互相等待的锁路径。

### 5.3 原子变量适合保护的单一状态

原子变量（atomic variable）定义在 `<atomic>`中。对一个 `std::atomic<T>`执行规定的原子操作时，其他线程不会观察到该操作只完成一半。

适合使用原子变量的情况包括：

- 单一停止标志：`std::atomic<bool> stop_requested`。
- 独立统计计数：`std::atomic<int> completed_count`。
- 使用 `fetch_add()`完成一次不可分割的加法更新。

```cpp
std::atomic<int> completed_count{0};
completed_count.fetch_add(1);
```

这里 `fetch_add(1)`原子地增加1，并返回增加前的旧值。若不需要旧值，可以忽略返回值。

本节使用原子操作的默认内存顺序，不展开 `memory_order`。不要在尚未掌握普通锁和条件变量时，为追求“无锁”随意指定较弱内存顺序。

### 5.4 原子操作不能自动保护复合不变量

把一个字段改成原子变量，只能保证针对该原子对象的规定操作。它不会自动保护其他普通字段，也不会把多步业务逻辑变成一个不可分割操作。

例如循环队列同时依赖：

- 读下标。
- 写下标。
- 当前元素数量。
- 对应槽位是否已经构造。

即使把 `size_`改成原子变量，其他字段之间仍可能不一致。把整个数据结构正确改造成无锁队列需要明确的算法和内存顺序，不能靠“所有整数都换成atomic”完成。

另一个例子是：

```cpp
if (count.load() > 0) {
    count.fetch_sub(1);
}
```

读取和减一分别是原子操作，但两步合起来不是自动不可分割。两个线程可能都观察到大于0，然后都减一。复合状态通常更适合由互斥锁保护，或者使用专门设计的一次性原子操作。

### 5.5 工作线程退出、`join()`与对象销毁顺序

线程安全退出的基本顺序是：

1. 共享状态、互斥量和条件变量已经构造完成。
2. 启动工作线程。
3. 主线程设置停止状态。
4. 若线程可能在条件变量上等待，发出通知让它重新检查停止状态。
5. 对所有工作线程执行 `join()`。
6. 线程完全结束后，再销毁其使用的共享对象。

```text
构造共享状态 → 启动线程 → 请求停止 → 唤醒等待者 → join → 销毁状态
```

阶段1-6会把停止标志、队列关闭、生产者和消费者唤醒组合成完整协议。本节先记住：不能先销毁线程正在使用的对象，再期望线程自行结束。

## 6 数据竞争、条件变量与死锁专项Demo

### 6.1 无锁计数器的数据竞争与TSan报告

这个小Demo只验证一个问题：两个线程无锁修改同一个普通整数会形成数据竞争。`counter`是全局对象，因此两个线程访问的是同一内存位置；两个线程最后都由主线程 `join()`。

`constexpr int increments_per_thread = 200000`定义一个编译期整数常量，用于固定每个线程的循环次数。它在程序运行期间不会被线程修改，不是本实验的共享可变数据。

```cpp
// data_race_demo.cpp
#include <iostream>
#include <thread>

int counter = 0;
constexpr int increments_per_thread = 200000;

void increment_counter() {
    for (int index = 0; index < increments_per_thread; ++index) {
        // 两个线程无同步地读、修改并写回同一个普通int，形成数据竞争。
        ++counter;
    }
}

int main() {
    std::thread first(increment_counter);
    std::thread second(increment_counter);

    first.join();
    second.join();

    std::cout << "expected: " << increments_per_thread * 2 << '\n';
    std::cout << "actual: " << counter << '\n';
}
```

普通编译和运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -pthread \
    data_race_demo.cpp -o data_race_demo
./data_race_demo
```

Linux下的 `-pthread`让编译器和链接器按POSIX线程环境构建程序；本文所有使用 `std::thread`的Linux命令都保留该选项。

`actual`可能小于400000，也可能偶然等于400000。任何一次输出都不能证明代码安全，因为程序已经存在无同步冲突访问。

线程消毒器（ThreadSanitizer，TSan）是一种由编译器插桩实现的数据竞争检测工具。GCC官方文档说明，`-fsanitize=thread`会对内存访问插桩以检测数据竞争，建议配合 `-g`获得更有意义的报告，并且不能与AddressSanitizer同时启用，见[GCC Instrumentation Options](https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html#index-fsanitize_003dthread)。

在支持TSan的Linux环境编译：

```bash
g++ -std=c++17 -g -O1 -pthread -fsanitize=thread \
    -fno-omit-frame-pointer data_race_demo.cpp -o data_race_tsan
./data_race_tsan
```

其中，`-g`生成调试信息，`-O1`启用较轻量优化，`-fsanitize=thread`启用TSan，`-fno-omit-frame-pointer`保留栈帧指针以改善调用栈信息。

报告中的重点信息应包括：

- `WARNING: ThreadSanitizer: data race`。
- 冲突访问的源文件和行号。
- 哪些线程执行了读写。
- 线程在什么位置创建。

验收标准是TSan能够指出 `++counter`附近的冲突访问，而不是要求普通输出每次都错误。

### 6.2 `lock_guard`保护共享计数器

这个Demo只验证上一故障的直接修复：两个线程访问 `counter`前都取得同一把 `counter_mutex`。

`std::lock_guard<std::mutex>`的组成已在第3.2节解释。每次循环构造守卫时加锁，离开当前循环体时自动解锁。

```cpp
// mutex_counter_demo.cpp
#include <iostream>
#include <mutex>
#include <thread>

int counter = 0;
std::mutex counter_mutex;
constexpr int increments_per_thread = 200000;

void increment_counter() {
    for (int index = 0; index < increments_per_thread; ++index) {
        // counter的每次读、修改、写回都在同一把锁保护下完成。
        std::lock_guard<std::mutex> lock(counter_mutex);
        ++counter;
    }
}

int main() {
    std::thread first(increment_counter);
    std::thread second(increment_counter);

    first.join();
    second.join();

    std::cout << "expected: " << increments_per_thread * 2 << '\n';
    std::cout << "actual: " << counter << '\n';
}
```

编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -pthread \
    mutex_counter_demo.cpp -o mutex_counter_demo
./mutex_counter_demo
```

预期输出：

```text
expected: 400000
actual: 400000
```

也可以使用与6.1相同的TSan参数重新编译。验收时应得到正确计数，并且不再报告这个计数器的数据竞争。

这个写法为了清楚证明每次递增受保护，会频繁加锁。实际批量统计可以先在线程局部变量中累加，再偶尔把一批结果合并到共享计数器，减少锁竞争；前提是不能改变业务要求。

### 6.3 使用谓词等待线程结果

这个小Demo只验证条件变量的正确等待流程。共享状态包括 `result`和 `result_ready`，两者都由 `result_mutex`保护。

代码中的关键类型已经在第3、4节解释：生产线程使用 `lock_guard`修改状态；消费线程使用 `unique_lock`，因为 `wait`需要暂时解锁；`wait`的Lambda谓词检查 `result_ready`。

```cpp
// condition_variable_demo.cpp
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <thread>

std::mutex result_mutex;
std::condition_variable result_condition;
int result = 0;
bool result_ready = false;

void consume_result() {
    std::unique_lock<std::mutex> lock(result_mutex);

    // 条件为假时，wait释放result_mutex并阻塞；
    // 醒来后重新加锁并再次检查result_ready。
    result_condition.wait(lock, [] {
        return result_ready;
    });

    std::cout << "result: " << result << '\n';
}

void produce_result() {
    {
        std::lock_guard<std::mutex> lock(result_mutex);
        result = 42;
        result_ready = true;
    }

    // 状态已经写好并解锁，再唤醒一个等待线程。
    result_condition.notify_one();
}

int main() {
    std::thread consumer(consume_result);
    std::thread producer(produce_result);

    producer.join();
    consumer.join();
}
```

编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -pthread \
    condition_variable_demo.cpp -o condition_variable_demo
./condition_variable_demo
```

预期输出固定为：

```text
result: 42
```

即使生产线程在消费线程真正进入等待前完成，谓词看到 `result_ready == true`后也会直接通过。可以把线程创建顺序交换后再次运行，结果仍应正确。

### 6.4 双锁死锁、超时与线程栈定位

这个程序故意制造死锁，不能直接把它当作普通程序无限等待。实验使用两把互斥量和一个原子计数器 `first_locks_acquired`：两个线程各自取得第一把锁后增加计数；只有计数达到2，它们才同时尝试取得对方持有的第二把锁。

`std::this_thread::yield()`提示调度器当前线程暂时没有有效工作，可以让其他可运行线程获得执行机会。它不提供业务同步；真正用于协调本实验的是原子计数器。

日志后的 `std::flush`强制把当前输出缓冲内容立即写出。因为程序随后会死锁，若不主动刷新，日志可能仍留在缓冲区中，看不到线程已经取得哪一把锁。

```cpp
// deadlock_demo.cpp
#include <atomic>
#include <iostream>
#include <mutex>
#include <thread>

std::mutex left_mutex;
std::mutex right_mutex;
std::atomic<int> first_locks_acquired{0};

void lock_left_then_right() {
    std::lock_guard<std::mutex> left_lock(left_mutex);
    std::cout << "thread A locked left\n" << std::flush;
    first_locks_acquired.fetch_add(1);

    while (first_locks_acquired.load() < 2) {
        std::this_thread::yield();
    }

    // 线程B持有right_mutex，因此线程A会在这里等待。
    std::lock_guard<std::mutex> right_lock(right_mutex);
}

void lock_right_then_left() {
    std::lock_guard<std::mutex> right_lock(right_mutex);
    std::cout << "thread B locked right\n" << std::flush;
    first_locks_acquired.fetch_add(1);

    while (first_locks_acquired.load() < 2) {
        std::this_thread::yield();
    }

    // 线程A持有left_mutex，因此线程B会在这里等待。
    std::lock_guard<std::mutex> left_lock(left_mutex);
}

int main() {
    std::thread first(lock_left_then_right);
    std::thread second(lock_right_then_left);

    // 两个工作线程互相等待，所以主线程也会卡在join中。
    first.join();
    second.join();
}
```

编译后使用GNU `timeout`限制运行时间：

```bash
g++ -std=c++17 -g -O0 -Wall -Wextra -pedantic -pthread \
    deadlock_demo.cpp -o deadlock_demo
timeout 3s ./deadlock_demo
echo $?
```

`timeout 3s`允许程序最多运行3秒，超时后终止它；`echo $?`显示上一条命令的退出状态。应看到两个线程分别取得第一把锁，然后停止前进；GNU `timeout`超时终止程序时，常见退出状态为124。

使用GDB定位时：

```bash
gdb ./deadlock_demo
```

进入GDB后运行：

```text
(gdb) run
程序卡住后按Ctrl+C
(gdb) thread apply all backtrace
```

GDB官方文档说明，`thread apply all backtrace`会显示所有线程的调用栈，适合分析多线程程序卡住的位置，见[GDB Backtrace文档](https://sourceware.org/gdb/current/onlinedocs/gdb.html/Backtrace.html)。应能看到两个工作线程分别停在取得第二把互斥量的位置，主线程停在 `join()`附近。

### 6.5 使用`scoped_lock`修复双锁死锁

修复程序保留两把互斥量，但不再分两步、反方向取得它们。两个线程都用一个 `std::scoped_lock`对象同时管理两把锁。

`std::scoped_lock lock(left_mutex, right_mutex)`使用C++17类模板实参推导；编译器根据构造参数推导锁的类型。它在构造时以避免死锁的方式取得两把锁，析构时释放。

```cpp
// deadlock_fixed_demo.cpp
#include <iostream>
#include <mutex>
#include <thread>

std::mutex left_mutex;
std::mutex right_mutex;
int completed_workers = 0;

void worker_one() {
    std::scoped_lock lock(left_mutex, right_mutex);
    ++completed_workers;
}

void worker_two() {
    // 即使构造参数顺序相反，scoped_lock也按多锁算法统一处理。
    std::scoped_lock lock(right_mutex, left_mutex);
    ++completed_workers;
}

int main() {
    std::thread first(worker_one);
    std::thread second(worker_two);

    first.join();
    second.join();

    std::cout << "completed workers: " << completed_workers << '\n';
}
```

`completed_workers`虽然是普通整数，但两个线程修改它时都同时持有同样的两把锁，因此没有并发无锁写入。主线程在两个 `join()`返回后读取它，此时两个写入都已完成。

编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic -pthread \
    deadlock_fixed_demo.cpp -o deadlock_fixed_demo
./deadlock_fixed_demo
```

预期输出：

```text
completed workers: 2
```

### 6.6 Demo结果与锁、原子变量选择验收

完成五个Demo后，应能根据共享状态选择同步方式：

| 需求 | 首选思路 |
|---|---|
| 多线程只读一份不再变化的数据 | 保证发布前初始化完成，之后保持只读 |
| 多线程修改一个独立计数器 | 原子计数或锁，根据是否还有其他关联状态决定 |
| 多个字段必须保持一致 | 用同一把互斥锁保护完整不变量 |
| 线程等待某个状态成立 | 互斥锁、共享状态和条件变量 |
| 一次必须取得多把锁 | 统一锁顺序或使用 `scoped_lock` |
| 线程停止时可能正在等待 | 在锁内设置停止状态，通知条件变量，再 `join()` |

最终验收问题：

1. 两个线程同时读取普通整数是否一定需要锁？如果期间没有线程写入，则不因这两个只读操作形成数据竞争。
2. `shared_ptr`的引用计数线程安全，是否等于它管理的对象线程安全？不等于。
3. 为什么条件变量必须检查共享状态？通知本身不保存业务事实，也可能发生虚假唤醒。
4. `lock_guard`和 `unique_lock`怎样选择？固定作用域加锁优先用前者，需要条件变量或可控解锁时用后者。
5. 原子 `size_`能否自动让阶段1-4的循环队列线程安全？不能，队列包含多个必须保持一致的字段和槽位。
6. 程序卡住时怎样证明双锁死锁？查看全部线程栈，找出各线程已经持有和正在等待的锁，确认循环等待。
7. 为什么不能先销毁共享状态再 `join()`？工作线程可能仍在访问已经销毁的对象。
8. `detach()`之后 `joinable()`为 `false`，是否表示工作线程已经结束？不表示，只说明原 `std::thread`对象已经不再关联和管理该线程。
