---
title: '[嵌入式AI-C++工程] 有限队列、背压与安全退出'
published: 2026-09-24T08:05:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍有限队列、背压与安全退出的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-6 有限队列、背压与安全退出

有限队列是在生产者和消费者之间保存有限数量任务的缓冲区。它不仅负责传递数据，还必须明确回答三个问题：队列满了怎么办、系统过载时保留哪些任务、程序关闭时怎样唤醒并结束所有等待线程。

本节承接阶段1-4第3节的循环队列，以及阶段1-5第3至5节的互斥锁、条件变量和线程退出知识。重点不是再实现一种容器，而是把这些基础能力组合成可以安全用于异步任务流水线的并发队列。

## 1 有界队列、无界队列与任务积压

### 1.1 队列容量、当前深度与任务等待时间

生产者（Producer）负责产生任务，消费者（Consumer）负责取出并处理任务。队列位于二者之间，使生产和消费不必在同一时刻完成。

理解队列运行状态需要区分三个量：

- **容量（capacity）**：队列最多能够同时保存多少个任务。
- **当前深度（depth或size）**：此刻已经入队但尚未出队的任务数量。
- **任务等待时间**：一个任务从入队到被消费者取出的时间。

容量为4、当前保存3个任务时，队列深度是3，还剩1个可写槽位。深度不能直接代表处理速度，但深度长期接近容量通常说明消费者跟不上生产者。

有界队列（bounded queue）具有明确的最大容量。无界队列（unbounded queue）不在接口层限制元素数量，但它并不拥有无限内存；它只会在压力出现时继续申请进程内存，直到生产速度下降、进程内存耗尽或操作系统终止进程。

### 1.2 生产速度与消费速度不匹配产生的积压

假设相机每秒产生30帧，而推理线程每秒只能处理15帧。忽略短时波动时，每秒大约会新增15个尚未处理的帧：

```text
每秒积压量 ≈ 每秒生产数量 - 每秒消费数量
           ≈ 30 - 15
           ≈ 15帧
```

无界队列只能暂时隐藏这个问题。运行1分钟后可能积压约900帧；即使每帧最终都会处理，推理结果也会越来越旧。

有限队列可以限制积压数量，但队列一旦填满，就必须选择阻塞生产者、拒绝任务或丢弃某些任务。也就是说，**有限队列不会消除吞吐量不足，只会迫使程序明确处理过载。**

短时间的深度上升不一定是故障。例如消费者偶尔执行一次耗时初始化，队列先积压后恢复为空，说明缓冲区吸收了短时波动。真正的问题是队列深度长期不下降。

### 1.3 任务积压与内存泄漏的区别

积压和内存泄漏都可能表现为进程内存不断增大，但原因不同：

| 问题 | 对象是否仍能通过正常引用找到 | 内存增长原因 | 典型证据 |
|---|---:|---|---|
| 任务积压 | 能，任务仍保存在队列中 | 生产速度长期高于消费速度 | 队列深度与内存一起增长 |
| 内存泄漏 | 通常不能正常访问，但资源没有释放 | 所有权或释放路径错误 | 队列深度稳定，内存仍持续增长 |

积压中的任务不是“泄漏”，因为队列仍然拥有它们；但这不代表积压无害。无界积压同样可能耗尽内存，而且会增加结果延迟。

排查时应同时记录队列深度和进程内存：

- 深度持续增长、内存同步增长：优先检查生产与消费吞吐量。
- 深度稳定、每个任务处理完成后内存仍增长：再检查资源释放和缓存上限。
- 使用有限队列后深度稳定在容量附近：内存得到控制，但系统仍处于持续过载状态。

## 2 背压的含义、传播过程与策略选择

### 2.1 背压如何把下游压力反馈给上游

背压（Backpressure）是指下游处理能力不足时，通过阻塞、拒绝、超时或丢弃，把“处理不过来”这个事实反馈给上游。背压不是某一个C++类或函数，而是一种系统流量控制机制。

以“采集线程 → 队列 → 推理线程”为例：

```text
采集线程产生帧
        ↓
有限队列逐渐填满
        ↓
执行预先选择的满队列策略
        ↓
采集线程等待 / 当前帧被拒绝 / 旧帧被丢弃
```

如果选择阻塞，压力会继续传回采集线程；如果采集设备自身还有缓冲区，压力可能继续传到驱动层。如果选择丢弃，采集可以继续，但应用必须接受数据不完整。

队列只能吸收短时速度波动。下游长期慢于上游时，最终一定要降低输入速度、增加消费能力或丢弃部分任务。

### 2.2 阻塞、拒绝、丢弃最新与丢弃最旧策略

队列满时常见策略如下：

| 策略 | 满队列时的动作 | 优点 | 主要风险 |
|---|---|---|---|
| 阻塞生产者 | 等到消费者释放槽位 | 不丢任务，顺序完整 | 上游可能长时间停住 |
| 拒绝新任务 | 当前任务不入队，立即返回失败 | 调用方能感知过载 | 调用方必须处理失败或重试 |
| 丢弃最新任务 | 保留队列内容，放弃当前任务 | 已排队任务不受影响 | 最新数据无法进入系统 |
| 丢弃最旧任务 | 移除队首，再写入当前任务 | 保留较新的数据，控制延迟 | 无法保证每个任务都处理 |
| 超时等待 | 最多等待指定时间 | 同时限制丢失和阻塞时间 | 超时后仍需决定失败处理方式 |

“丢弃最旧”不等于“消费者下一次直接取得刚到达的最新任务”。例如容量为3，当前队列按入队顺序保存`帧1、帧2、帧3`，新来的帧4会先删除队头帧1，再追加到队尾：

```text
写入帧4之前：[帧1（最旧）, 帧2, 帧3（最新）]
写入帧4之后：[帧2（最旧）, 帧3, 帧4（最新）]
下一次出队：帧2
```

队列仍然遵守先进先出，只是把允许落后的范围限制在容量之内。如果消费者每次都必须直接取得最新帧，应使用容量为1的覆盖式队列，或者另外实现“清空当前积压并只返回最后一个任务”的接口。

策略是业务语义的一部分，不能由队列随意猜测。例如“丢弃最旧任务”对于实时预览很合理，但对于保存录像、统计每件产品或处理支付请求可能是严重错误。

拒绝和丢弃还必须可观察。接口应通过返回值告诉调用方本次写入是否成功，队列内部也应累计丢弃或拒绝数量，不能静默丢数据。

### 2.3 实时任务与离线任务的队列策略选择

实时任务更关心数据的新鲜程度，离线任务更关心数据完整程度：

| 任务类型 | 更重要的目标 | 常用策略 |
|---|---|---|
| 相机实时预览 | 尽快显示最新画面 | 丢弃最旧帧 |
| 实时目标跟踪 | 控制端到端延迟 | 小容量队列并丢弃旧帧 |
| 离线图片批处理 | 每张图片都必须完成 | 阻塞生产者 |
| 文件保存和审计日志 | 数据不能静默丢失 | 阻塞、持久化或明确报错 |
| 在线请求服务 | 调用方需要知道是否接收 | 拒绝或超时 |

选择策略前应回答：

1. 任务是否允许丢失？
2. 如果允许，旧任务和新任务哪个更有价值？
3. 上游能否安全阻塞？
4. 调用方能否处理失败或重试？
5. 系统允许的最大等待时间是多少？

## 3 `BoundedQueue`的状态、接口与并发保护

本节实现`BoundedQueue<T, Capacity>`：

- `T`是队列保存的元素类型。
- `Capacity`是编译期确定的最大元素数量，必须大于0。
- 内部存储使用阶段1-4第3.3节已经解释过的`CircularQueue<T, Capacity>`。
- 并发层增加互斥锁、两个条件变量、关闭状态和运行统计。

类模板必须在使用点看到完整定义，因此下面的代码保存为`bounded_queue.h`头文件，而不是只在头文件声明后把模板实现放到普通`.cpp`文件中。

### 3.1 循环队列、容量、关闭标志与统计状态

并发队列需要把下面这些状态视为一个整体：

- 循环队列中的元素、读下标、写下标和当前数量。
- `closed_`：是否已经禁止后续入队。
- `max_depth_`：运行期间观察到的最大队列深度。
- `dropped_`：因为丢弃最旧策略而移除的任务数量。
- 生产者等待次数和累计等待时间。

这些变量全部由同一个`mutex_`保护。原因是很多操作不是单独读取一个变量，而是“检查状态后再修改多个变量”。例如丢弃最旧任务需要在同一个临界区中完成：检查已满、弹出队首、增加丢弃计数、写入新任务。

`QueueStats`是统计快照类型。调用`stats()`时在锁内复制当前值，返回后调用方读取的是某一时刻的快照，不会继续引用队列内部变量。

### 3.2 阻塞入队、非阻塞入队与丢弃最旧入队

三个入队接口拥有不同语义：

```cpp
PushStatus push_wait(T value);
PushStatus try_push(T value);
PushStatus push_drop_oldest(T value);
```

`PushStatus`是枚举类型，用来明确返回三种结果：

- `pushed`：写入成功。
- `closed`：队列已经关闭，拒绝写入。
- `full`：非阻塞写入遇到满队列。

`push_wait()`在队列已满时使用`not_full_`条件变量等待；`try_push()`不会等待；`push_drop_oldest()`在已满时先移除队首元素。三个接口都按值接收`T`，再把它移动到循环队列中，移动语义见阶段1-3第1.3节。

### 3.3 阻塞出队的等待条件与返回结果

出队接口为：

```cpp
std::optional<T> pop_wait();
```

`std::optional<T>`已经在阶段1-4第3.3节解释：有值表示成功取得一个任务；没有值表示队列已经关闭并且剩余任务已经取完。

消费者不能因为队列暂时为空就退出。它需要等待下面两个条件之一成立：

```text
队列非空：取出一个任务
队列已关闭：如果没有剩余任务，结束消费循环
```

因此等待谓词是`closed_ || !storage_.empty()`，而不是只检查“队列非空”。这也是关闭操作能够唤醒空队列消费者的基础。

### 3.4 互斥锁与两个条件变量的保护范围

队列使用两个条件变量：

- `not_empty_`：消费者等待“队列非空或已经关闭”。
- `not_full_`：阻塞生产者等待“队列未满或已经关闭”。

使用两个条件变量可以让通知对象更明确。成功入队后通知一个消费者；成功出队后通知一个生产者；关闭时两边都必须`notify_all()`。

下面是完整头文件。`std::unique_lock`、带谓词的`wait()`和先修改共享状态再通知的规则见阶段1-5第3.3节与第4节。

```cpp
// bounded_queue.h
#ifndef BOUNDED_QUEUE_H
#define BOUNDED_QUEUE_H

#include <array>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <mutex>
#include <optional>
#include <utility>

enum class PushStatus {
    pushed,  // 本次任务已经进入队列
    closed,  // 队列已经关闭，本次任务没有进入队列
    full     // 仅用于非阻塞写入：队列已满，本次任务没有进入队列
};

struct QueueStats {
    std::size_t depth{0};          // 生成快照时，队列中仍有多少个任务
    std::size_t max_depth{0};      // 从启动到现在出现过的最大深度
    std::size_t dropped{0};        // 使用丢弃最旧策略移除的任务总数
    std::size_t producer_waits{0}; // 生产者因满队列进入等待的次数
    long long producer_wait_us{0}; // 生产者累计等待时间，单位为微秒
    bool closed{false};            // 生成快照时是否已经禁止继续入队
};

// 单线程循环队列的职责只是管理固定槽位和下标回绕。
// 所有并发访问都由外层BoundedQueue持锁后发起。
// T表示元素类型，Capacity表示固定槽位数量。
template <typename T, std::size_t Capacity>
class CircularQueue {
    static_assert(Capacity > 0, "queue capacity must be greater than zero");

public:
    bool push(T value) {
        if (full()) {
            // 循环队列本身不决定阻塞还是丢弃，只报告没有空槽位。
            return false;
        }

        // tail_始终指向下一次写入位置。
        // emplace在空optional中构造元素，std::move避免不必要的深拷贝。
        slots_[tail_].emplace(std::move(value));

        // 到达数组末尾后通过取余回到0，形成循环。
        tail_ = (tail_ + 1) % Capacity;
        ++size_;
        return true;
    }

    std::optional<T> pop() {
        if (empty()) {
            // 无值表示当前没有元素可取。
            return std::nullopt;
        }

        // head_始终指向当前最旧元素，也就是下一次出队位置。
        std::optional<T> value = std::move(slots_[head_]);

        // 元素已经移出，必须把原槽位恢复为空，供后续写入复用。
        slots_[head_].reset();
        head_ = (head_ + 1) % Capacity;
        --size_;
        return value;
    }

    bool empty() const { return size_ == 0; }
    bool full() const { return size_ == Capacity; }
    std::size_t size() const { return size_; }

private:
    // 每个optional对应一个槽位：有值表示已占用，无值表示空闲。
    std::array<std::optional<T>, Capacity> slots_{};
    std::size_t head_{0}; // 下一次读取的槽位，也就是当前最旧元素
    std::size_t tail_{0}; // 下一次写入的槽位
    std::size_t size_{0}; // 已占用槽位数，用来区分队列空和队列满
};

template <typename T, std::size_t Capacity>
class BoundedQueue {
public:
    // mutex和condition_variable本身不可复制，显式删除可以让接口意图更清楚。
    BoundedQueue() = default;
    BoundedQueue(const BoundedQueue&) = delete;
    BoundedQueue& operator=(const BoundedQueue&) = delete;

    PushStatus push_wait(T value) {
        // unique_lock在当前作用域内持有mutex_。
        // condition_variable::wait需要它来完成“解锁、睡眠、重新加锁”。
        std::unique_lock<std::mutex> lock(mutex_);

        // 只有确实因满队列进入等待时，才记录一次生产者等待。
        const bool must_wait = storage_.full() && !closed_;
        const auto wait_begin = std::chrono::steady_clock::now();
        if (must_wait) {
            ++producer_waits_;
        }

        not_full_.wait(lock, [this] {
            // close必须也是唤醒条件，否则满队列生产者可能永远阻塞。
            return closed_ || !storage_.full();
        });

        // wait返回时，lock已经重新取得mutex_，可以安全读取队列状态。
        if (must_wait) {
            producer_wait_time_ +=
                std::chrono::steady_clock::now() - wait_begin;
        }

        if (closed_) {
            // close唤醒了生产者，但关闭后的任务不能再写入。
            return PushStatus::closed;
        }

        // 谓词已经确认队列未满，并且整个检查过程都受同一把锁保护，
        // 所以这里写入一定有空槽位。
        storage_.push(std::move(value));
        update_max_depth();

        // 修改共享状态后先释放锁，再唤醒一个消费者。
        lock.unlock();
        not_empty_.notify_one();
        return PushStatus::pushed;
    }

    PushStatus try_push(T value) {
        // try_push是非阻塞接口：只取得锁检查一次，不等待空槽位。
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (closed_) {
                return PushStatus::closed;
            }
            if (storage_.full()) {
                // 调用方可根据full决定丢弃、重试或记录过载。
                return PushStatus::full;
            }

            storage_.push(std::move(value));
            update_max_depth();
        }

        not_empty_.notify_one();
        return PushStatus::pushed;
    }

    PushStatus push_drop_oldest(T value) {
        // “检查已满、删除旧任务、写入新任务”必须在同一个临界区完成。
        {
            std::lock_guard<std::mutex> lock(mutex_);
            if (closed_) {
                return PushStatus::closed;
            }

            if (storage_.full()) {
                // pop删除的是head_指向的队首，也就是当前最旧任务。
                // 例如[帧1, 帧2, 帧3]写入帧4后变成[帧2, 帧3, 帧4]。
                // 下一次pop取得帧2，而不是直接取得刚写入的帧4。
                storage_.pop();
                ++dropped_;
            }

            // 新任务总是追加到队尾，仍然保持先进先出顺序。
            storage_.push(std::move(value));
            update_max_depth();
        }

        // 入队后可能有消费者正在等待空队列，唤醒其中一个即可。
        not_empty_.notify_one();
        return PushStatus::pushed;
    }

    std::optional<T> pop_wait() {
        // 消费者先取得队列锁，再根据谓词决定立即取任务还是睡眠。
        std::unique_lock<std::mutex> lock(mutex_);
        not_empty_.wait(lock, [this] {
            // 非空时可以消费；关闭时必须醒来判断是否已经排空。
            return closed_ || !storage_.empty();
        });

        // 能走到这里且仍为空，只可能是队列已经关闭并且已排空。
        if (storage_.empty()) {
            return std::nullopt;
        }

        // 循环队列的pop始终移除head_指向的最旧任务。
        std::optional<T> value = storage_.pop();

        // 元素已经离开队列，先释放锁，再通知一个等待空槽位的生产者。
        // 返回后执行的推理或文件处理不再持有队列锁。
        lock.unlock();
        not_full_.notify_one();
        return value;
    }

    void close() {
        {
            std::lock_guard<std::mutex> lock(mutex_);
            // 重复调用close仍然只是保持true，因此这个操作是幂等的。
            // closed_与队列内容由同一把锁保护，等待谓词能看到一致状态。
            closed_ = true;
        }

        // 消费者可能在等非空，生产者可能在等非满，两边都要唤醒。
        not_empty_.notify_all();
        not_full_.notify_all();
    }

    QueueStats stats() const {
        // 在锁内复制全部字段，保证返回的是同一时刻的一致快照。
        std::lock_guard<std::mutex> lock(mutex_);
        return QueueStats{
            storage_.size(),
            max_depth_,
            dropped_,
            producer_waits_,
            std::chrono::duration_cast<std::chrono::microseconds>(
                producer_wait_time_).count(),
            closed_
        };
    }

private:
    void update_max_depth() {
        // 调用者已经持有mutex_，这个私有函数不能在无锁状态下调用。
        if (storage_.size() > max_depth_) {
            max_depth_ = storage_.size();
        }
    }

    // storage_以及下面所有统计和关闭状态都由mutex_统一保护。
    CircularQueue<T, Capacity> storage_;
    mutable std::mutex mutex_;
    std::condition_variable not_empty_; // 消费者等待“有任务或已关闭”
    std::condition_variable not_full_;  // 生产者等待“有空位或已关闭”
    bool closed_{false};                // true后永久拒绝新的入队请求

    // 统计量同样在mutex_保护下更新，stats()负责生成只读快照。
    std::size_t max_depth_{0};
    std::size_t dropped_{0};
    std::size_t producer_waits_{0};
    std::chrono::steady_clock::duration producer_wait_time_{};
};

#endif
```

`BoundedQueue`没有在析构函数中自动等待工作线程。队列对象无法知道外部保存了哪些线程，也无法替外部决定排空还是取消。正确做法是由拥有线程和队列的上层对象明确执行`close()`与`join()`，然后再销毁队列。

## 4 `close()`语义与工作线程安全退出

### 4.1 停止接收、排空队列与立即取消的区别

“停止系统”至少可能表示三种不同动作：

- **停止接收**：禁止新任务入队，但保留已有任务。
- **排空后退出（drain）**：消费者继续处理已有任务，队列空后退出。
- **立即取消（cancel）**：放弃队列中的剩余任务并尽快退出。

本节`BoundedQueue`实现的是“停止接收并排空后退出”：`close()`之后所有入队接口返回`PushStatus::closed`，消费者仍能取出关闭前已经入队的任务；只有“已关闭并且为空”时，`pop_wait()`才返回无值。

如果项目需要立即取消，应单独设计`cancel()`的语义，包括如何清理剩余任务、正在处理的任务能否中断，以及调用方如何得知任务未完成。不能偷偷把`close()`改成清空队列，否则调用者无法判断剩余任务去了哪里。

### 4.2 `close()`唤醒生产者和消费者的过程

调用`close()`时可能存在两类等待线程：

```text
空队列：消费者阻塞在not_empty_
满队列：生产者阻塞在not_full_
```

因此关闭过程必须是：

1. 取得互斥锁。
2. 把`closed_`设置为`true`。
3. 释放互斥锁。
4. 对`not_empty_`调用`notify_all()`。
5. 对`not_full_`调用`notify_all()`。

被唤醒不代表线程一定能够读写。每个线程重新取得锁后还会检查谓词和`closed_`：消费者在队列非空时继续排空；生产者看到关闭后返回失败。

这里不能只用一个原子布尔值代替完整协议。原子标志能够让线程安全地读取“是否关闭”，但不能自动唤醒正在条件变量中睡眠的线程，也不能独立保护队列状态与关闭状态之间的复合判断。

### 4.3 停止生产、关闭队列、消费剩余任务与`join()`顺序

对于“生产线程 → 队列 → 消费线程”，安全退出顺序通常是：

```text
1. 请求生产线程停止产生新任务
2. join生产线程，确认不会再调用入队接口
3. close队列，禁止写入并唤醒等待线程
4. 消费线程处理完队列中的剩余任务
5. pop_wait返回无值，消费线程结束
6. join消费线程
7. 销毁队列及任务依赖的资源
```

如果生产逻辑就在主线程中，可以在最后一次入队后直接调用`close()`，再等待消费者结束。

复杂流水线需要沿数据方向逐级关闭。例如“采集 → 预处理 → 推理”中，先停止采集并关闭采集队列；预处理线程排空并结束后，再关闭推理队列。一次性关闭所有队列可能使上游仍在产生的结果无法交给下游。

### 4.4 永久阻塞、对象提前销毁与持锁处理任务

常见错误包括：

1. **只设置关闭标志，不通知条件变量**：睡眠线程不会主动醒来检查新值。
2. **等待谓词没有包含关闭状态**：线程醒来后发现队列仍空或仍满，又继续睡眠。
3. **先销毁队列，再`join()`线程**：线程可能继续访问已经析构的互斥锁、条件变量和存储区。
4. **持有队列锁处理任务**：消费者取出任务后仍不解锁，生产者无法入队，其他消费者也无法工作。
5. **关闭后仍忽略入队返回值**：任务已经被拒绝，但调用方误以为提交成功。

队列锁只应保护队列内部状态。推理、文件写入、网络发送等耗时操作必须在`pop_wait()`返回后、队列锁已经释放的情况下执行。

## 5 队列深度、等待时间、丢弃数量与内存指标

### 5.1 队列运行指标的含义与记录方法

只观察程序“有没有崩溃”无法判断队列是否健康。至少应记录：

| 指标 | 含义 | 异常表现 |
|---|---|---|
| 当前深度 | 当前尚未处理的任务数 | 长期接近容量 |
| 最大深度 | 运行期间出现过的最高深度 | 经常达到容量 |
| 生产者等待次数 | 阻塞策略实际触发次数 | 持续快速增加 |
| 生产者累计等待时间 | 上游因队列满损失的时间 | 占运行时间比例过高 |
| 丢弃数量 | 为保留新任务而移除的旧任务数 | 持续增加说明长期过载 |
| 任务等待时间 | 从产生到开始处理的时间 | 持续增大或超过业务要求 |
| 进程内存 | 队列及任务资源占用 | 深度稳定时仍持续增长 |

`stats()`在互斥锁内生成快照。不要为了输出日志长时间持有队列内部锁；取出快照后再格式化和写日志。

### 5.2 慢消费者、持续积压与吞吐量不足的判断

可以故意让消费者休眠，模拟推理或编码耗时。观察结果时分三种情况：

- **阻塞策略**：深度达到容量后不再增长，生产者等待时间增加，任务不丢失。
- **丢弃最旧策略**：深度不超过容量，丢弃数量增加，消费者主要处理较新的任务。
- **无界队列**：生产结束前深度持续增加，任务等待时间和内存都可能增长。

队列长期满载不表示队列实现失败。它通常是在准确暴露下游吞吐量不足。后续处理方法可能是降低输入帧率、减小模型耗时、增加消费者并行度或接受丢帧。

### 5.3 数据正确但实时性失效的排查方法

并发程序没有数据竞争、每个任务内容也正确，仍可能不满足实时性。排查顺序可以是：

1. 检查任务产生时间与开始处理时间的差值。
2. 检查当前深度和最大深度是否长期接近容量。
3. 检查使用的满队列策略是否符合任务目标。
4. 检查消费者单次处理时间及波动。
5. 检查任务内部是否持有大块图像或模型输出，使有限数量任务仍占用过多内存。

实时视觉系统常见的故障是“结果完全正确，但对应的是几秒前的画面”。这不是数据竞争，而是排队等待时间超过了实时性要求。

## 6 有限队列、背压策略与安全退出Demo

下面四段程序分别验证四个知识点。先把第3节的代码保存为`bounded_queue.h`，再把每个Demo保存为自己的`.cpp`文件。它们没有命令行模式选择，每个可执行文件只展示一种固定行为。

### 6.1 阻塞式有限队列Demo

这个Demo回答：容量用完后，`push_wait()`是否真的等待消费者释放槽位？

程序先在容量为2的队列中写入两个整数，再启动生产线程写入第三个整数。主线程等待约200毫秒后弹出一个元素，因此生产线程的第三次写入应阻塞约200毫秒。

```cpp
// blocking_queue_demo.cpp
#include "bounded_queue.h"

#include <chrono>
#include <iostream>
#include <thread>

int main() {
    using Clock = std::chrono::steady_clock;
    BoundedQueue<int, 2> queue;

    // 这两个变量只由生产线程写入；主线程会在join之后读取，
    // 因此不需要额外使用原子变量或互斥锁。
    PushStatus producer_status = PushStatus::closed;
    long long producer_waited_ms = 0;

    // 先填满两个槽位，确保后面的生产线程会进入等待。
    queue.push_wait(10);
    queue.push_wait(20);

    std::thread producer([&queue, &producer_status, &producer_waited_ms] {
        // push_wait(30)暂时无法完成，因为两个槽位都已占用。
        const auto begin = Clock::now();
        producer_status = queue.push_wait(30);

        // 只有主线程弹出一个元素，生产线程被唤醒并完成写入后，
        // 才会执行到这里并得到完整等待时间。
        producer_waited_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
            Clock::now() - begin).count();
    });

    // 在这段时间内队列保持满状态，生产线程不能写入30。
    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    // pop_wait取出队头10并释放一个槽位，然后通知not_full_。
    // 生产线程随后可以把30写到队尾，队列内容变为[20, 30]。
    const std::optional<int> first = queue.pop_wait();
    std::cout << "main popped: " << *first << '\n';

    producer.join();
    // join建立同步关系；此后主线程可以安全读取生产线程保存的结果。
    std::cout << "producer pushed: "
              << (producer_status == PushStatus::pushed)
              << ", waited_ms: " << producer_waited_ms << '\n';
    // 已经确认不会再有生产者写入，现在关闭队列。
    queue.close();

    // close后仍能排空关闭前已经进入队列的20和30。
    while (const std::optional<int> value = queue.pop_wait()) {
        std::cout << "drain: " << *value << '\n';
    }

    const QueueStats stats = queue.stats();
    std::cout << "max_depth: " << stats.max_depth
              << ", producer_waits: " << stats.producer_waits << '\n';
}
```

依赖：C++17标准库和`bounded_queue.h`。输入：程序内部固定整数。编译运行：

```bash
g++ -std=c++17 -O2 -Wall -Wextra -pedantic -pthread \
    blocking_queue_demo.cpp -o blocking_queue_demo
./blocking_queue_demo
```

输出中的具体等待时间会受线程调度影响，但应接近或大于200毫秒，元素顺序应为10、20、30，`max_depth`应为2，`producer_waits`应为1。最重要的验收条件是：队列深度没有超过2，第三次写入在弹出10前没有完成。

### 6.2 丢弃最旧任务Demo

这个Demo只验证丢弃最旧策略，不创建线程。单线程足以证明满队列时保存哪些任务，避免并发输出干扰观察结果。

容量为3，依次写入1到6。写入4、5、6时，每次都应移除当前最旧任务，所以最后只保留4、5、6，累计丢弃3个任务。

```cpp
// drop_oldest_queue_demo.cpp
#include "bounded_queue.h"

#include <iostream>
#include <optional>

int main() {
    BoundedQueue<int, 3> queue;

    for (int task_id = 1; task_id <= 6; ++task_id) {
        // 1、2、3直接入队；从4开始，每次写入前先删除当前队头。
        const PushStatus status = queue.push_drop_oldest(task_id);

        // stats()返回当前时刻的副本，打印时不继续占用队列锁。
        const QueueStats stats = queue.stats();

        std::cout << "push " << task_id
                  << ", accepted: " << (status == PushStatus::pushed)
                  << ", depth: " << stats.depth
                  << ", dropped: " << stats.dropped << '\n';
    }

    // close禁止继续写入，但不会删除队列中剩余的4、5、6。
    queue.close();

    std::cout << "remaining:";
    while (const std::optional<int> task = queue.pop_wait()) {
        // FIFO仍然有效：依次取出4、5、6，而不是先取最新的6。
        std::cout << ' ' << *task;
    }
    std::cout << '\n';
}
```

编译运行：

```bash
g++ -std=c++17 -O2 -Wall -Wextra -pedantic -pthread \
    drop_oldest_queue_demo.cpp -o drop_oldest_queue_demo
./drop_oldest_queue_demo
```

关键输出应为：

```text
push 6, accepted: 1, depth: 3, dropped: 3
remaining: 4 5 6
```

验收时确认：深度从未超过3；任务1、2、3被移除；任务4、5、6保持先进先出顺序。这个策略保证容量和数据新鲜度，不保证每个任务都被处理。

### 6.3 `close()`唤醒等待线程Demo

这个Demo同时建立两个独立队列：一个空队列让消费者等待，另一个满队列让生产者等待。主线程关闭两者后，消费者的`pop_wait()`应返回无值，生产者的`push_wait()`应返回`PushStatus::closed`。

两个队列只用于验证同一个知识点：`close()`必须同时唤醒等待非空的消费者和等待非满的生产者。

```cpp
// close_queue_demo.cpp
#include "bounded_queue.h"

#include <chrono>
#include <iostream>
#include <optional>
#include <thread>

int main() {
    BoundedQueue<int, 1> empty_queue;
    BoundedQueue<int, 1> full_queue;

    // 每个布尔变量只由对应工作线程写入，主线程在join后统一读取。
    bool consumer_stopped = false;
    bool producer_saw_closed = false;

    // 容量为1，预先写入10后full_queue已经没有空槽位。
    full_queue.push_wait(10);

    std::thread consumer([&empty_queue, &consumer_stopped] {
        // 空队列没有任务，这里一直等到close改变等待条件。
        const std::optional<int> value = empty_queue.pop_wait();
        consumer_stopped = !value.has_value();
    });

    std::thread producer([&full_queue, &producer_saw_closed] {
        // 容量为1且已有10，这次写入一直等到close将其唤醒。
        const PushStatus status = full_queue.push_wait(20);
        producer_saw_closed = (status == PushStatus::closed);
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(200));

    // empty_queue.close()唤醒等待not_empty_的消费者；
    // full_queue.close()唤醒等待not_full_的生产者。
    empty_queue.close();
    full_queue.close();

    // 只有两个close都正确修改状态并发送通知，这两个join才能返回。
    consumer.join();
    producer.join();
    // 两个线程已经结束，主线程统一输出，避免多线程日志字符交错。
    std::cout << "consumer stopped: " << consumer_stopped << '\n';
    std::cout << "producer saw closed: " << producer_saw_closed << '\n';
    std::cout << "all waiting threads joined\n";
}
```

编译运行：

```bash
g++ -std=c++17 -O2 -Wall -Wextra -pedantic -pthread \
    close_queue_demo.cpp -o close_queue_demo
timeout 3s ./close_queue_demo
```

两条线程日志的先后顺序不固定，但布尔值都应为1，并在3秒内输出`all waiting threads joined`。如果删除`close()`中的任意一个`notify_all()`，对应的等待线程就可能永久阻塞，`timeout`最终会终止程序。

### 6.4 慢消费者与队列指标主项目验证

这个验证模拟“采集任务 → 有限队列 → 慢处理线程”。`FrameTask`保存帧编号和产生时间；主线程每30毫秒产生一帧，消费者每处理一帧需要100毫秒。容量只有4，因此固定使用丢弃最旧策略控制等待时间。

`std::chrono::steady_clock`是单调时钟，适合计算持续时间，不会因为系统时间被校准而向后跳。任务年龄等于“开始处理时间减去产生时间”。

```cpp
// slow_consumer_demo.cpp
#include "bounded_queue.h"

#include <chrono>
#include <cstddef>
#include <iostream>
#include <optional>
#include <thread>

struct FrameTask {
    int frame_id{0}; // 用连续编号观察哪些旧帧被丢弃
    std::chrono::steady_clock::time_point created_at; // 计算排队等待时间
};

int main() {
    using namespace std::chrono_literals;
    using Clock = std::chrono::steady_clock;

    BoundedQueue<FrameTask, 4> frame_queue;

    // processed_count只由消费者修改，主线程在consumer.join()后读取。
    std::size_t processed_count = 0;

    std::thread consumer([&frame_queue, &processed_count] {
        // pop_wait在队列为空时睡眠；close且排空后返回nullopt，循环结束。
        while (const std::optional<FrameTask> task = frame_queue.pop_wait()) {
            // 此处已经离开队列临界区。耗时处理不会阻止生产者入队。
            const auto age_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                Clock::now() - task->created_at).count();

            std::cout << "process frame " << task->frame_id
                      << ", queue_age_ms: " << age_ms << '\n';

            // 固定耗时模拟推理线程慢于采集线程。
            std::this_thread::sleep_for(100ms);
            ++processed_count;
        }
    });

    for (int frame_id = 1; frame_id <= 20; ++frame_id) {
        // created_at记录帧产生时刻，而不是消费者开始处理的时刻。
        FrameTask task{frame_id, Clock::now()};

        // 队列满时删除当前队头，再把新帧追加到队尾。
        // 消费者下一次仍取剩余最旧帧，不会直接跳到刚写入的新帧。
        const PushStatus status = frame_queue.push_drop_oldest(std::move(task));
        if (status != PushStatus::pushed) {
            // 正常流程在生产结束后才close，所以这里表示退出顺序出错。
            std::cerr << "queue closed before producer finished\n";
            break;
        }

        // 约33帧/秒；消费者每帧耗时100毫秒，只能处理约10帧/秒。
        std::this_thread::sleep_for(30ms);
    }

    // 主线程不再产生任务，关闭后让消费者排空剩余帧。
    frame_queue.close();

    // 必须先等待消费者退出，之后才能读取processed_count并销毁队列。
    consumer.join();

    const QueueStats stats = frame_queue.stats();
    std::cout << "processed: " << processed_count
              << ", dropped: " << stats.dropped
              << ", max_depth: " << stats.max_depth
              << ", final_depth: " << stats.depth << '\n';
}
```

编译运行：

```bash
g++ -std=c++17 -O2 -Wall -Wextra -pedantic -pthread \
    slow_consumer_demo.cpp -o slow_consumer_demo
./slow_consumer_demo
```

还可以在Linux上观察进程最大常驻内存：

```bash
/usr/bin/time -v ./slow_consumer_demo
```

线程调度会影响具体处理编号和等待时间，因此不要求每次输出完全相同。应满足以下验收条件：

1. `max_depth`不超过4，并且最终`final_depth`为0。
2. 因为消费者明显更慢，`dropped`应大于0。
3. `processed + dropped`应等于成功提交的20个任务。
4. 程序能够正常结束，消费者没有永久阻塞。
5. 延长运行时间时，队列占用仍受4个任务限制，不会因为积压无限增长。

如果把实时处理改成离线批处理，应把生产路径改为`push_wait()`，并接受生产者等待；不能继续丢弃最旧任务。策略变化来自业务目标变化，不是队列性能优化技巧。

完成本节后应能回答：为什么有限队列不能解决吞吐量不足；实时任务和离线任务为什么使用不同满队列策略；`close()`为什么必须唤醒两类等待线程；为什么要先让使用队列的线程结束，再销毁队列对象。
