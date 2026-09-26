---
title: '[嵌入式AI-视频工程] V4L2采集流程'
published: 2026-09-24T08:13:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍V4L2采集流程的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-3 V4L2采集流程

V4L2（Video for Linux 2）是Linux向用户程序提供的视频设备接口。本节只讨论最常见的一条采集路径：程序使用`V4L2_MEMORY_MMAP`申请由驱动管理的缓冲区，把这些缓冲区映射到用户空间，再通过队列反复取得摄像头写完的图像。

完整调用顺序是：

```text
open
→ VIDIOC_QUERYCAP
→ VIDIOC_S_FMT
→ VIDIOC_REQBUFS
→ 对每个缓冲区执行VIDIOC_QUERYBUF和mmap
→ 对每个缓冲区执行VIDIOC_QBUF
→ VIDIOC_STREAMON
→ poll、VIDIOC_DQBUF、处理、VIDIOC_QBUF循环
→ VIDIOC_STREAMOFF
→ munmap、释放缓冲区、close
```

阶段2-1已经解释YUYV、NV12等像素格式，阶段2-2已经解释`bytesperline`、`sizeimage`和逐行访问。本节直接使用这些结论，把重点放在调用顺序和缓冲区使用权上。DMA-BUF导出、设备间共享与缓存同步继续放在阶段2-4。

## 1 V4L2流式采集的设备、缓冲区与完整调用顺序

用户程序首先打开`/dev/video0`之类的视频设备节点：

```cpp
int video_fd = open("/dev/video0", O_RDWR | O_NONBLOCK);
if (video_fd == -1) {
    perror("open /dev/video0");
    return 1;
}
```

`video_fd`是文件描述符（已在阶段1-9第6节解释），后续`ioctl()`、`mmap()`和`poll()`都通过它找到同一个打开的V4L2设备。文件描述符不是图像地址，也不保存一帧图像。

MMAP采集还涉及另外两个对象：

- **V4L2缓冲区对象**：由驱动管理，以从0开始的`index`标识，记录大小、队列状态和本次采集的元数据。
- **用户空间映射地址**：程序执行`mmap()`后得到的CPU虚拟地址，用来读取对应缓冲区中的图像。

同一个V4L2缓冲区对象可以一直保持映射，所以程序会长期保存它的地址；但是地址仍然存在，不等于程序随时都可以访问里面的数据。什么时候可以读取，由第6节的`QBUF`和`DQBUF`状态转换决定。

V4L2的用户空间类型和命令定义在`<linux/videodev2.h>`，`ioctl()`声明在`<sys/ioctl.h>`。调用形式统一为：

```cpp
int result = ioctl(video_fd, request, &argument);
```

其中`request`是`VIDIOC_QUERYCAP`等操作编号，`argument`指向与该操作匹配的结构体。成功返回0，失败返回-1并设置`errno`。实际代码通常用一个小函数处理被信号打断的情况：

```cpp
int xioctl(int fd, unsigned long request, void* argument) {
    int result;
    do {
        result = ioctl(fd, request, argument);
    } while (result == -1 && errno == EINTR);
    return result;
}
```

`EINTR`表示线程在系统调用期间收到信号，操作尚未正常完成。这里重新执行原调用；其他错误交给调用处根据当前操作处理。

## 2 使用VIDIOC_QUERYCAP确认视频采集与流式I/O能力

`VIDIOC_QUERYCAP`用于确认当前设备节点支持什么功能。Linux内核文档要求V4L2应用在打开设备后调用它，不能仅凭路径叫`/dev/video0`就假设它一定支持当前采集方式。[Linux内核：Querying Capabilities](https://docs.kernel.org/userspace-api/media/v4l/querycap.html)

```cpp
v4l2_capability capability{};
if (xioctl(video_fd, VIDIOC_QUERYCAP, &capability) == -1) {
    perror("VIDIOC_QUERYCAP");
    return 1;
}

// capabilities描述整个物理设备；设置DEVICE_CAPS时，device_caps才描述当前节点。
const std::uint32_t device_caps =
    (capability.capabilities & V4L2_CAP_DEVICE_CAPS)
        ? capability.device_caps
        : capability.capabilities;

if ((device_caps & V4L2_CAP_VIDEO_CAPTURE) == 0) {
    std::cerr << "当前Demo需要单平面视频采集接口\n";
    return 1;
}

if ((device_caps & V4L2_CAP_STREAMING) == 0) {
    std::cerr << "设备不支持V4L2流式I/O\n";
    return 1;
}
```

`V4L2_CAP_VIDEO_CAPTURE`表示设备支持单平面采集接口，`V4L2_CAP_VIDEO_CAPTURE_MPLANE`表示支持多平面采集接口。两者可以同时存在，但本文Demo明确选择单平面接口，因此后续所有`type`都使用`V4L2_BUF_TYPE_VIDEO_CAPTURE`，不能在中途换成`V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`。

`V4L2_CAP_STREAMING`只说明设备支持流式I/O这一类机制。当前buffer type是否支持`V4L2_MEMORY_MMAP`，还要以第4节`VIDIOC_REQBUFS`的结果为准。[Linux内核：VIDIOC_QUERYCAP](https://docs.kernel.org/userspace-api/media/v4l/vidioc-querycap.html)

部分SoC摄像头使用Media Controller组织传感器、CSI接收器和ISP流水线。此时`QUERYCAP`成功也不保证整条媒体链路已经配置完成；如果`STREAMON`返回`ENOLINK`或`EPIPE`，还要检查媒体拓扑和各sub-device格式。这属于具体平台的摄像头管线配置，不在本节展开。

## 3 使用VIDIOC_S_FMT协商采集格式并读取驱动返回值

`VIDIOC_S_FMT`不是把应用填写的值原样写给硬件，而是让应用和驱动协商格式。驱动可以把不支持的宽高调整为可用值，也会填写实际的`bytesperline`和`sizeimage`。因此调用成功后，后续代码必须读取返回后的结构体，不能继续使用调用前自己保存的猜测值。[Linux内核：Data Formats](https://docs.kernel.org/userspace-api/media/v4l/format.html)

下面请求1280×720的YUYV采集；调用返回后，`format.fmt.pix`已经被驱动改写为实际结果：

```cpp
v4l2_format format{};
format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
format.fmt.pix.width = 1280;
format.fmt.pix.height = 720;
format.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
format.fmt.pix.field = V4L2_FIELD_NONE;

if (xioctl(video_fd, VIDIOC_S_FMT, &format) == -1) {
    perror("VIDIOC_S_FMT");
    return 1;
}

const v4l2_pix_format& actual = format.fmt.pix;
// 后续统一使用actual中的width、height、pixelformat、bytesperline和sizeimage。
```

假设应用请求1280×720，驱动返回1280×704，后续保存文件、创建`cv::Mat`或提交编码器时都必须使用1280×704。相同原则也适用于像素格式：若程序只会解释YUYV，而返回值不是`V4L2_PIX_FMT_YUYV`，程序应停止并报告不支持，而不是把其他格式按YUYV读取。

`bytesperline`和`sizeimage`的地址含义见阶段2-2第1、5节。这里新增的规则只有一条：这些值由本次格式协商返回，缓冲区申请和图像访问必须使用返回值。

如果只想检查某个格式会被调整成什么，而暂时不改变设备状态，可以尝试`VIDIOC_TRY_FMT`；该操作是可选能力，正式设置仍以`VIDIOC_S_FMT`返回结果为准。

## 4 使用VIDIOC_REQBUFS、VIDIOC_QUERYBUF与mmap准备采集缓冲区

### 4.1 VIDIOC_REQBUFS请求缓冲区并取得实际数量

`VIDIOC_REQBUFS`选择缓冲区类型和内存模式，并请求一组缓冲区。对当前MMAP采集路径：

```cpp
v4l2_requestbuffers request{};
request.count = 4;  // Demo希望循环使用4个缓冲区。
request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
request.memory = V4L2_MEMORY_MMAP;

if (xioctl(video_fd, VIDIOC_REQBUFS, &request) == -1) {
    perror("VIDIOC_REQBUFS");
    return 1;
}
if (request.count < 2) {
    std::cerr << "Demo要求驱动至少返回2个缓冲区\n";
    return 1;
}
```

这里要求至少2个是Demo自己的流水处理前提，不是V4L2规定所有设备都必须返回2个。程序申请4个，最后应按`request.count`遍历。例如驱动返回3，就只允许使用`index=0、1、2`。

MMAP模式下，驱动或其内存后端负责建立缓冲区；`REQBUFS`返回的只是缓冲区数量和能力，不会返回可供CPU访问的地址。[Linux内核：VIDIOC_REQBUFS](https://docs.kernel.org/userspace-api/media/v4l/vidioc-reqbufs.html)

从驱动内部看，应用通过哪个video节点调用`REQBUFS`，就会进入该节点在注册时绑定的`vb2_queue`。驱动已经在队列中指定了缓冲区类型、负责访问内存的硬件设备，以及`vb2_dma_contig_memops`或`vb2_dma_sg_memops`等内存后端。MMAP模式下的主要过程是：

```text
VIDIOC_REQBUFS
→ V4L2驱动找到当前video节点的vb2_queue
→ videobuf2与驱动协商实际buffer数量和每个buffer的memory plane数量
→ 为每个buffer建立vb2_buffer对象
→ 队列的mem_ops为每个plane分配后备内存
→ DMA内存后端针对queue->dev或alloc_devs[]准备设备DMA地址
→ 将后备内存和分配器私有信息保存在对应plane中
```

如果该硬件设备经过IOMMU，DMA API提供给驱动的设备地址通常是IOVA；没有经过IOMMU时，则是该设备能够使用的DMA地址。IOMMU映射是在分配、准备还是入队阶段完成，取决于具体内存后端和驱动，应用不能把它固定理解为一定发生在`QBUF`。videobuf2对MMAP队列的职责可参考[Linux内核：V4L2 videobuf2框架](https://docs.kernel.org/driver-api/media/v4l2-videobuf2.html)。

### 4.2 VIDIOC_QUERYBUF取得缓冲区长度与映射偏移

程序对每个有效`index`执行`VIDIOC_QUERYBUF`。单平面接口通过`v4l2_buffer.length`返回映射长度，通过`v4l2_buffer.m.offset`返回供`mmap()`使用的偏移：

```cpp
struct MappedBuffer {
    void* address = MAP_FAILED;  // 当前进程访问缓冲区的起始虚拟地址。
    std::size_t length = 0;      // mmap和munmap都必须使用该缓冲区的实际长度。
};

std::vector<MappedBuffer> buffers(request.count);

for (std::uint32_t index = 0; index < request.count; ++index) {
    v4l2_buffer query{};
    query.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    query.memory = V4L2_MEMORY_MMAP;
    query.index = index;

    if (xioctl(video_fd, VIDIOC_QUERYBUF, &query) == -1) {
        perror("VIDIOC_QUERYBUF");
        // 调用者必须解除此前已经成功建立的映射。
        return 1;
    }

    buffers[index].length = query.length;
    buffers[index].address = mmap(
        nullptr,
        query.length,
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        video_fd,
        query.m.offset);

    if (buffers[index].address == MAP_FAILED) {
        perror("mmap V4L2 buffer");
        return 1;
    }
}
```

`query.m.offset`由驱动提供，用于让设备的`mmap`实现找到指定V4L2缓冲区；程序不应把它改成自己计算的帧偏移。`query.length`是本次映射长度，也应原样保存到对应的`MappedBuffer`中。

### 4.3 mmap建立用户空间访问地址与部分失败清理

`mmap()`成功以后，程序获得的是当前进程中的CPU虚拟地址。它没有复制图像，也没有启动摄像头。MMAP模式的分配与映射关系可参考[Linux内核：Streaming I/O (Memory Mapping)](https://docs.kernel.org/userspace-api/media/v4l/mmap.html)。

`mmap()`的`fd`和`offset`分别回答两个问题：`fd`指出由哪个video节点的驱动处理映射，`offset`指出映射这个节点管理的哪个buffer或plane。这个offset是驱动返回的映射选择值，不是像素偏移，也不能当作物理地址使用。内核中的主要过程是：

```text
mmap(video_fd, length, offset)
→ 内核通过fd找到video节点的文件对象和mmap回调
→ V4L2驱动把请求交给videobuf2
→ videobuf2通过offset找到一个buffer中的指定plane
→ 内存后端取得该plane的后备物理页、PFN或设备内存
→ 内核创建当前进程的VMA并建立页表映射
→ mmap返回CPU虚拟地址
```

VMA（Virtual Memory Area，虚拟内存区域）记录这段进程虚拟地址的范围、权限和映射来源。驱动可以在`mmap()`期间直接建立页表，也可以登记缺页回调，在CPU第一次访问某一页时补上对应映射。之后CPU访问返回地址时，由CPU MMU按照进程页表翻译到这些后备页面。

这条CPU访问路径与设备DMA路径相互独立：`mmap()`不负责给ISP或RAW采集DMA建立IOMMU映射；设备DMA地址由4.1所述的DMA内存后端和DMA API准备。二者最终访问同一份后备内存，但CPU使用进程虚拟地址，硬件使用DMA地址或IOVA。

初始化可能在任意一个`index`失败，因此清理代码要遍历已经建立的映射：地址不等于`MAP_FAILED`才调用`munmap(address, length)`。这套逻辑同时用于初始化失败和正常退出。不要对`MAP_FAILED`调用`munmap()`，也不要使用统一的理论帧大小代替各缓冲区实际返回的`length`。

## 5 使用VIDIOC_QBUF、VIDIOC_STREAMON、poll与VIDIOC_DQBUF采集图像

### 5.1 初始入队与启动视频流

完成映射后，所有缓冲区最初都不在驱动的采集队列里。程序先逐个执行`VIDIOC_QBUF`：

```cpp
for (std::uint32_t index = 0; index < buffers.size(); ++index) {
    v4l2_buffer buffer{};
    buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    buffer.memory = V4L2_MEMORY_MMAP;
    buffer.index = index;
    if (xioctl(video_fd, VIDIOC_QBUF, &buffer) == -1) {
        perror("initial VIDIOC_QBUF");
        return 1;
    }
}

v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
if (xioctl(video_fd, VIDIOC_STREAMON, &type) == -1) {
    perror("VIDIOC_STREAMON");
    return 1;
}
```

先入队再启动，是为了让采集开始时驱动已经有缓冲区可写。若`STREAMON`失败，已经`QBUF`的缓冲区仍可能保持入队状态；退出路径应继续执行`STREAMOFF`或关闭设备完成复位。[Linux内核：VIDIOC_STREAMON与VIDIOC_STREAMOFF](https://docs.kernel.org/userspace-api/media/v4l/vidioc-streamon.html)

从驱动内部看，`QBUF`和`STREAMON`并不是同一个动作：

```text
VIDIOC_QBUF
→ videobuf2检查index、plane大小和当前buffer状态
→ 执行驱动的buf_prepare回调及必要的缓存同步
→ buffer进入当前video节点的可用队列
→ 驱动可从plane的分配器信息中取得DMA地址或SG表

VIDIOC_STREAMON
→ videobuf2确认已经有足够的已入队buffer
→ 调用驱动的start_streaming回调
→ 驱动从可用队列选择一个buffer
→ 把各plane的DMA地址、stride和图像尺寸写入该节点绑定的DMA寄存器或描述符
→ 启动当前ISP输出或RAW采集通道及完成中断
```

video节点创建时已经与具体硬件输出通道绑定，例如ISP主输出节点对应主输出DMA，RAW节点对应RAW采集DMA。因此驱动不是在`QBUF`时临时寻找“哪个DMA”，而是把当前buffer的地址写入这个节点已经确定的DMA通道。只有`QBUF`而没有`STREAMON`时，buffer只是等待使用，当前采集流不会因此开始写图像。

可以把这一段压缩成一句话：`QBUF`只是把缓冲区放入驱动的可用队列，让驱动记录哪些buffer可以用于采集，并能够取得其已经准备好的DMA地址；`STREAMON`后，驱动取出一个可用buffer，把它的DMA地址写入当前节点绑定的DMA寄存器或描述符；DMA写完一帧后触发中断，驱动把buffer标记为`DONE`并放入完成队列，`poll()`随之唤醒；应用通过`DQBUF`取得这一帧，处理结束后再次`QBUF`，由此形成循环。

### 5.2 等待设备就绪并取回已完成缓冲区

设备以`O_NONBLOCK`打开后，程序使用`poll()`睡眠等待，不需要反复调用`DQBUF`占满CPU：

```cpp
pollfd descriptor{};
descriptor.fd = video_fd;
descriptor.events = POLLIN;

int poll_result;
do {
    poll_result = poll(&descriptor, 1, 2000);  // 最多等待2000毫秒。
} while (poll_result == -1 && errno == EINTR);

if (poll_result == 0) {
    std::cerr << "等待一帧超过2000毫秒\n";
    return 1;
}
if (poll_result == -1) {
    perror("poll");
    return 1;
}
if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
    std::cerr << "视频设备poll返回错误事件: 0x"
              << std::hex << descriptor.revents << std::dec << '\n';
    return 1;
}
```

这里的2000毫秒是Demo主动选择的故障检测时间，不是V4L2规定的超时。实际项目应根据帧率、设备启动延迟和断流恢复策略设定。例如30 FPS正常帧间隔约为33.3毫秒，但USB重传、自动曝光切换或管线启动可能让个别帧明显变慢，不能直接把超时设为34毫秒。

`poll()`返回只表示当前可以尝试出队。真正取得已完成缓冲区仍要调用`VIDIOC_DQBUF`：

```cpp
v4l2_buffer dequeued{};
dequeued.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
dequeued.memory = V4L2_MEMORY_MMAP;

if (xioctl(video_fd, VIDIOC_DQBUF, &dequeued) == -1) {
    if (errno == EAGAIN) {
        // 非阻塞模式下当前没有可出队帧，回到poll等待，不是致命错误。
        return 0;
    }
    perror("VIDIOC_DQBUF");
    return -1;
}

if (dequeued.index >= buffers.size()) {
    std::cerr << "驱动返回了越界buffer index\n";
    return -1;
}
```

非阻塞`DQBUF`在没有完成帧时返回`EAGAIN`是接口定义的一部分。[Linux内核：VIDIOC_QBUF与VIDIOC_DQBUF](https://docs.kernel.org/userspace-api/media/v4l/vidioc-qbuf.html) 程序应回到`poll()`，而不是把它记录成摄像头故障。

### 5.3 index、bytesused、timestamp、sequence与flags的含义

成功出队后，驱动会在`v4l2_buffer`中返回本帧信息：

| 字段 | 本次采集中的含义 | 程序怎样使用 |
| --- | --- | --- |
| `index` | 本次完成的是哪一个已映射缓冲区 | 用它选择`buffers[index].address` |
| `bytesused` | 当前帧在该缓冲区中写入的有效字节数 | 保存压缩帧或记录数据量时使用 |
| `timestamp` | 驱动记录的采集时间 | 与传感器、推理或编码结果对时 |
| `sequence` | 驱动提供的帧序号 | 相邻值跳变可作为丢帧线索 |
| `flags` | 当前缓冲区状态和附加标志 | 检查`V4L2_BUF_FLAG_ERROR`等状态 |

`bytesused`、`bytesperline`和`sizeimage`不能混用：前者来自本次`DQBUF`，后两者来自格式协商。对于MJPEG等压缩格式，`bytesused`会随每帧压缩结果变化；对未压缩图像，逐行访问仍应使用阶段2-2说明的格式、宽高和stride，不能用`bytesused / height`反推每行跨度。

访问前必须确认`dequeued.index < buffers.size()`且`dequeued.bytesused <= buffers[dequeued.index].length`。`V4L2_BUF_FLAG_ERROR`表示本帧发生了可恢复的流错误，数据可能损坏；程序可以记录并丢弃这一帧，然后正常把缓冲区重新入队，不必因此终止整条视频流。

## 6 DQBUF与QBUF之间的缓冲区使用权和异步处理边界

### 6.1 缓冲区在应用与驱动之间的状态变化

MMAP完成后，映射地址一直保存在进程中，但缓冲区内容的使用权会在应用与驱动之间转换：

```text
完成mmap
→ 缓冲区未入队，应用持有

应用调用QBUF
→ 缓冲区被锁定并交给驱动
→ 驱动可以让采集硬件写入
→ 应用不得再读写其中的数据

驱动写完一帧，应用成功调用DQBUF
→ 缓冲区回到应用
→ 应用可以读取本帧

应用处理完并再次QBUF
→ 缓冲区重新交给驱动
→ 旧图像随时可能被下一帧覆盖
```

Linux内核对`QBUF`的定义很明确：入队会把缓冲区交给驱动用于硬件访问，在缓冲区重新出队、执行`STREAMOFF`、释放缓冲区或关闭设备前，应用访问其中内容的结果没有定义。[Linux内核：VIDIOC_QBUF与VIDIOC_DQBUF](https://docs.kernel.org/userspace-api/media/v4l/vidioc-qbuf.html)

所以代码判断不能写成“`address`不是空指针，因此可以读取”。正确条件是：对应`index`已经成功`DQBUF`，并且尚未再次`QBUF`。

### 6.2 立即处理、复制图像与转移缓冲区使用权

同步处理最简单：采集线程在`DQBUF`后读取图像，处理完成再对同一`index`执行`QBUF`。如果处理只需几毫秒且缓冲区充足，这种方式容易保证正确。

异步处理时有两种明确策略。

**策略一：复制有效数据。** 采集线程把本帧复制到自己拥有的内存，然后立刻`QBUF`。工作线程只处理副本，不再访问V4L2映射。复制未压缩图像时要遵循阶段2-2的逐行规则；不能在存在padding时无条件复制`width × height × pixel_size`个连续字节。

```text
DQBUF取得index=2
→ 按实际格式和stride复制到应用缓冲区
→ QBUF归还index=2
→ 工作线程处理应用缓冲区
```

**策略二：转移V4L2缓冲区的临时使用权。** 采集线程把`index`和必要元数据交给工作线程，暂不执行`QBUF`。工作线程处理完成后归还`index`，再由约定的线程重新入队。

```text
DQBUF取得index=2
→ 任务队列接收{index=2, bytesused, timestamp}
→ 工作线程读取buffers[2]
→ 工作线程报告index=2处理完成
→ 采集线程QBUF index=2
```

任务对象必须携带`index`，不能只携带裸指针，因为重新入队需要准确指定V4L2缓冲区。若项目规定只有采集线程操作设备fd，工作线程就不直接调用`QBUF`，而是把完成的`index`放进返回队列。

阶段1-6已经解释有限队列、背压和工作线程退出，这里只补充V4L2特有的约束：任务仍引用某个V4L2缓冲区时，该缓冲区不能重新入队，也不能被`munmap()`。

### 6.3 提前QBUF造成图像覆盖与延迟QBUF造成缓冲区耗尽

下面是常见的错误顺序：

```cpp
const void* frame_address = buffers[dequeued.index].address;
task_queue.push(frame_address);

// 错误：工作线程尚未读完，驱动已经可以覆盖frame_address指向的内容。
xioctl(video_fd, VIDIOC_QBUF, &dequeued);
```

这种错误不一定立即崩溃，因为映射地址仍然有效。更常见的现象是同一帧上下部分来自不同采集时刻、算法结果偶发变化，或者日志中的任务编号与实际画面不一致。

反过来，如果应用出队后长期不归还缓冲区，可供驱动写入的缓冲区会逐个减少。假设实际有4个缓冲区，工作线程同时占住4个且都没有归还，第5帧到达时驱动没有空缓冲区可以继续正常循环，应用随后会表现为`poll()`超时或不再取得新帧。

因此缓冲区数量只能吸收有限时间的处理抖动，不能修复长期低于输入帧率的处理能力。处理持续过慢，应选择复制后及时归还、限制异步在途数量、丢帧，或者让下游直接消费共享缓冲区并建立明确的完成通知。最后一种方案的DMA-BUF与设备同步边界见阶段2-4第2.6节。

## 7 V4L2单平面与多平面采集接口的结构差异

### 7.1 buffer type与格式结构的对应关系

V4L2的单平面和多平面是两套用户接口。选择哪一套，由`buffer type`决定，并且格式设置、缓冲区申请、查询、入队、出队和开关流必须保持一致。

| 操作位置 | 单平面采集接口 | 多平面采集接口 |
| --- | --- | --- |
| 能力标志 | `V4L2_CAP_VIDEO_CAPTURE` | `V4L2_CAP_VIDEO_CAPTURE_MPLANE` |
| buffer type | `V4L2_BUF_TYPE_VIDEO_CAPTURE` | `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE` |
| 格式结构 | `format.fmt.pix` | `format.fmt.pix_mp` |
| 平面格式信息 | `v4l2_pix_format`中的字段 | `v4l2_pix_format_mplane.plane_fmt[]` |
| 缓冲区查询与排队 | `v4l2_buffer`自身的长度和offset | `v4l2_buffer.m.planes`指向数组 |

多平面API能够承载单平面格式，但单平面API不能承载只为多平面API定义的格式。应用应根据设备能力、枚举到的格式和实际管线要求选择，而不是看到NV12三个字母就固定选择其中一套。[Linux内核：Single- and multi-planar APIs](https://docs.kernel.org/userspace-api/media/v4l/planar-apis.html)

### 7.2 多平面接口中v4l2_plane数组的准备和使用

多平面接口调用`QUERYBUF`、`QBUF`或`DQBUF`时，`v4l2_buffer`本身不直接存放每个plane的长度和offset。下面把两层关系完整写出：外层循环遍历`REQBUFS`实际返回的所有完整帧缓冲区，内层循环分别映射当前帧的每个memory plane。

`MappedPlane`保存一个plane的CPU映射，`MultiPlaneBuffer`保存一个完整帧缓冲区的全部plane；因此`mapped_buffers[buffer_index].planes[plane_index]`能够同时定位帧编号和平面编号。代码使用的`std::array`和`std::vector`分别来自`<array>`和`<vector>`。

```cpp
struct MappedPlane {
    void* address = MAP_FAILED; // 当前plane映射到本进程后的CPU虚拟地址。
    std::size_t length = 0;     // QUERYBUF返回的映射长度，也是munmap所需长度。
};

struct MultiPlaneBuffer {
    // 一个完整帧最多包含VIDEO_MAX_PLANES个memory plane。
    std::array<MappedPlane, VIDEO_MAX_PLANES> planes{};
    std::uint32_t plane_count = 0; // 当前格式实际使用的memory plane数量。
};

const std::uint32_t plane_count = format.fmt.pix_mp.num_planes;

if (plane_count == 0 || plane_count > VIDEO_MAX_PLANES) {
    std::cerr << "驱动返回的num_planes无效\n";
    return 1;
}

// request.count是多平面REQBUFS返回的完整帧缓冲区数量。
std::vector<MultiPlaneBuffer> mapped_buffers(request.count);

// 外层：依次处理buffer[0]、buffer[1]……每个index代表一个完整帧槽位。
for (std::uint32_t buffer_index = 0;
     buffer_index < request.count;
     ++buffer_index) {
    std::array<v4l2_plane, VIDEO_MAX_PLANES> query_planes{};
    v4l2_buffer query{};

    query.type = V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    query.memory = V4L2_MEMORY_MMAP;
    query.index = buffer_index;
    query.m.planes = query_planes.data();
    query.length = plane_count; // 数组中可由驱动填写的有效元素数量。

    if (xioctl(video_fd, VIDIOC_QUERYBUF, &query) == -1) {
        perror("VIDIOC_QUERYBUF MPLANE");
        // 返回前应解除此前buffer和plane已经成功建立的映射。
        return 1;
    }

    MultiPlaneBuffer& mapped_buffer = mapped_buffers[buffer_index];
    mapped_buffer.plane_count = plane_count;

    // 内层：分别映射当前完整帧中的每一个memory plane。
    for (std::uint32_t plane_index = 0;
         plane_index < plane_count;
         ++plane_index) {
        const v4l2_plane& query_plane = query_planes[plane_index];
        MappedPlane& mapped_plane = mapped_buffer.planes[plane_index];

        // 每个plane都有驱动单独返回的length和mem_offset，不能自行推算。
        mapped_plane.length = query_plane.length;
        mapped_plane.address = mmap(
            nullptr,
            query_plane.length,
            PROT_READ | PROT_WRITE,
            MAP_SHARED,
            video_fd,
            query_plane.m.mem_offset);

        if (mapped_plane.address == MAP_FAILED) {
            perror("mmap MPLANE");
            // 当前plane映射失败时，之前成功映射的地址仍需逐一munmap。
            return 1;
        }
    }
}
```

例如`request.count=4`且`plane_count=2`时，外层循环处理4个完整帧缓冲区，内层对每帧执行2次`mmap()`，合计建立8个plane映射。代码把地址分别保存在`mapped_buffers[0..3].planes[0..1]`，而不是用一个局部`address`覆盖前一次结果。

调用`DQBUF`时也必须再次提供有效的`planes`数组，并把`buffer.length`设为本次格式协商返回的`num_planes`，因为驱动要把每个plane的`bytesused`、`data_offset`等结果写回数组。不能只在`QUERYBUF`时准备一次局部数组，离开作用域后继续把失效地址留在`buffer.m.planes`中。

### 7.3 像素格式平面与memory plane的区别

阶段2-1第3.4节已经区分格式平面、内存分配次数和缓冲对象。放到V4L2中，可以直接对应为：

- **像素格式平面**描述图像分量怎样组织，例如NV12由Y格式平面和UV格式平面组成。
- **memory plane**描述一帧需要通过几个独立内存区域和地址交给接口。

两者数量不保证相等。一个包含Y和UV格式平面的NV12图像，可以由某些接口放在一块连续内存中，也可以由多平面格式放在两个独立memory plane中。程序必须使用格式FourCC、所选API和驱动返回的`num_planes`、`plane_fmt[]`共同判断，不能只根据“NV12是两平面格式”推断需要执行两次`mmap()`。

## 8 VIDIOC_STREAMOFF、munmap与设备关闭顺序

停止采集时，`VIDIOC_STREAMOFF`会停止流并把仍在队列中的缓冲区移出队列，使队列回到刚完成`REQBUFS`后的状态；尚未出队的已采集图像会丢失。它不是“等待应用把剩余帧全部处理完”的排空操作。[Linux内核：VIDIOC_STREAMON与VIDIOC_STREAMOFF](https://docs.kernel.org/userspace-api/media/v4l/vidioc-streamon.html)

资源按依赖关系逆序清理：

```text
不再创建新的异步任务
→ 等待或取消仍在读取V4L2缓冲区的工作任务
→ VIDIOC_STREAMOFF
→ munmap每个映射
→ VIDIOC_REQBUFS(count=0)释放缓冲区
→ close设备fd
```

`REQBUFS(count=0)`用于释放当前队列的缓冲区。在不支持孤儿缓冲区的驱动上，如果缓冲区仍被映射或导出，释放会失败，所以应先完成所有使用并解除映射。关闭设备也会回收内核资源，但显式清理能让正常路径和部分失败路径保持一致。

清理函数应接收真实状态：只有`streaming=true`才执行`STREAMOFF`，只对地址不等于`MAP_FAILED`的缓冲区执行`munmap()`，最后构造`count=0、type=V4L2_BUF_TYPE_VIDEO_CAPTURE、memory=V4L2_MEMORY_MMAP`的`v4l2_requestbuffers`释放队列。如果程序只映射了前两个缓冲区，就只解除这两个映射。记录初始化进度，比在所有失败分支复制一套清理代码更可靠。

## 9 V4L2 MMAP常用命令与完整采集Demo

### 9.1 使用v4l2-ctl和FFmpeg查询、试采集与保存图像视频

`v4l2-ctl`是`v4l-utils`工具包中的V4L2命令行工具，适合先确认设备节点、能力和格式，再运行自己的采集程序。FFmpeg用于预览、转换或编码采集结果。Ubuntu可安装：

```bash
sudo apt update
sudo apt install v4l-utils ffmpeg
```

列出设备及其video节点：

```bash
v4l2-ctl --list-devices
```

查看`/dev/video0`的驱动、能力、当前格式和控制项：

```bash
v4l2-ctl --device=/dev/video0 --all
```

列出设备支持的像素格式、宽高和帧率：

```bash
v4l2-ctl --device=/dev/video0 --list-formats-ext
```

请求1280×720 YUYV并读取驱动最终接受的格式。第二条命令的输出才是后续程序应使用的实际结果：

```bash
v4l2-ctl --device=/dev/video0 \
  --set-fmt-video=width=1280,height=720,pixelformat=YUYV

v4l2-ctl --device=/dev/video0 --get-fmt-video
```

使用4个MMAP缓冲区抓取100帧，但把数据写入`/dev/null`，用于确认`QBUF → STREAMON → DQBUF`循环能持续运行而不生成文件：

```bash
v4l2-ctl --device=/dev/video0 \
  --stream-mmap=4 \
  --stream-count=100 \
  --stream-to=/dev/null
```

抓取一帧YUYV原始数据：

```bash
v4l2-ctl --device=/dev/video0 \
  --set-fmt-video=width=1280,height=720,pixelformat=YUYV \
  --stream-mmap=4 \
  --stream-count=1 \
  --stream-to=frame.yuyv
```

当`--get-fmt-video`确认宽高为1280×720、像素格式为YUYV，并且每行没有额外padding时，可以把原始帧转换成PNG：

```bash
ffmpeg -f rawvideo \
  -pixel_format yuyv422 \
  -video_size 1280x720 \
  -i frame.yuyv \
  -frames:v 1 frame.png
```

如果驱动返回的`bytesperline`大于`width × 2`，`v4l2-ctl`保存的原始文件可能包含行尾padding，不能直接按紧密YUYV交给FFmpeg。下面完整Demo会逐行去除padding后再保存第一帧。

不保存文件，只预览摄像头：

```bash
ffplay -f v4l2 \
  -input_format yuyv422 \
  -video_size 1280x720 \
  -framerate 30 \
  /dev/video0
```

直接采集10秒并编码成H.264 MP4：

```bash
ffmpeg -f v4l2 \
  -input_format yuyv422 \
  -video_size 1280x720 \
  -framerate 30 \
  -i /dev/video0 \
  -t 10 \
  -c:v libx264 \
  -pix_fmt yuv420p capture.mp4
```

设备不支持示例格式或帧率时，应从`--list-formats-ext`的结果选择真实组合，不要只修改命令中的名称强行尝试。`v4l2-ctl`的流式参数可参考[v4l2-ctl手册](https://manpages.debian.org/bullseye/v4l-utils/v4l2-ctl.1.en.html)，FFmpeg的V4L2输入选项可参考[FFmpeg设备文档](https://ffmpeg.org/ffmpeg-devices.html#video4linux2_002c-v4l2)。

### 9.2 完整的单平面V4L2 MMAP循环采集Demo

下面程序固定完成一件事：从一个支持单平面MMAP采集的video节点请求1280×720 YUYV，循环采集100帧，打印每帧的buffer状态和元数据，并把第一帧逐行去除padding后保存为紧密排列的`first-frame.yuyv`。

程序使用C++17标准库、Linux系统调用和`<linux/videodev2.h>`，不依赖OpenCV。`CaptureContext`集中保存设备fd、驱动返回的实际格式、缓冲区状态和初始化进度；析构时按照`STREAMOFF → munmap → REQBUFS(count=0) → close`的顺序清理部分或全部初始化结果。

```cpp
#include <linux/videodev2.h>

#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/poll.h>

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

// 对ioctl被信号打断的情况自动重试；其他错误仍返回给调用者处理。
int xioctl(int fd, unsigned long request, void* argument) {
    int result;
    do {
        result = ioctl(fd, request, argument);
    } while (result == -1 && errno == EINTR);
    return result;
}

// 在抛出异常前保存errno，避免构造错误字符串时覆盖原错误码。
[[noreturn]] void throw_errno(const std::string& operation) {
    const int saved_errno = errno;
    throw std::runtime_error(
        operation + ": " + std::strerror(saved_errno));
}

std::string fourcc_to_string(std::uint32_t fourcc) {
    std::string text(4, '\0');
    text[0] = static_cast<char>(fourcc & 0xff);
    text[1] = static_cast<char>((fourcc >> 8) & 0xff);
    text[2] = static_cast<char>((fourcc >> 16) & 0xff);
    text[3] = static_cast<char>((fourcc >> 24) & 0xff);
    return text;
}

// 这个状态只用于教学日志和程序自检，不代替内核中的真实buffer状态。
enum class BufferState {
    MappedByApplication,   // 已mmap，但尚未交给驱动。
    QueuedToDriver,        // 已QBUF，驱动或DMA可以使用，应用不得读取。
    DequeuedToApplication  // 已DQBUF，当前由应用读取和处理。
};

struct MappedBuffer {
    void* address = MAP_FAILED;  // 当前进程访问该buffer的CPU虚拟地址。
    std::size_t length = 0;      // QUERYBUF返回的映射长度，munmap必须原样使用。
    BufferState state = BufferState::MappedByApplication;
};

// 保存一条单平面MMAP采集流的全部资源和实际格式。
struct CaptureContext {
    int video_fd = -1;                   // 当前进程持有的video设备fd。
    std::vector<MappedBuffer> buffers;   // index与vector下标一一对应。
    bool buffers_requested = false;      // REQBUFS是否已经成功。
    bool streaming = false;              // STREAMON是否已经成功。
    std::uint32_t width = 0;             // S_FMT返回的实际宽度，单位为像素。
    std::uint32_t height = 0;            // S_FMT返回的实际高度，单位为行。
    std::uint32_t pixel_format = 0;       // S_FMT返回的实际FourCC。
    std::uint32_t bytes_per_line = 0;     // 相邻两行起点间距，单位为字节。
    std::uint32_t size_image = 0;         // 驱动要求的最小图像缓冲容量，单位为字节。

    CaptureContext() = default;
    CaptureContext(const CaptureContext&) = delete;
    CaptureContext& operator=(const CaptureContext&) = delete;

    ~CaptureContext() {
        cleanup();
    }

    // 可在正常结束或任意初始化失败后调用；只释放已经成功取得的资源。
    void cleanup() noexcept {
        if (streaming && video_fd >= 0) {
            v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            if (xioctl(video_fd, VIDIOC_STREAMOFF, &type) == -1) {
                std::cerr << "VIDIOC_STREAMOFF: "
                          << std::strerror(errno) << '\n';
            }
            streaming = false;
        }

        // STREAMOFF完成后，DMA不再访问这些buffer，才能解除CPU映射。
        for (MappedBuffer& buffer : buffers) {
            if (buffer.address != MAP_FAILED) {
                if (munmap(buffer.address, buffer.length) == -1) {
                    std::cerr << "munmap: " << std::strerror(errno) << '\n';
                }
                buffer.address = MAP_FAILED;
                buffer.length = 0;
            }
        }
        buffers.clear();

        if (buffers_requested && video_fd >= 0) {
            v4l2_requestbuffers release{};
            release.count = 0;
            release.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
            release.memory = V4L2_MEMORY_MMAP;
            if (xioctl(video_fd, VIDIOC_REQBUFS, &release) == -1) {
                std::cerr << "VIDIOC_REQBUFS count=0: "
                          << std::strerror(errno) << '\n';
            }
            buffers_requested = false;
        }

        if (video_fd >= 0) {
            if (close(video_fd) == -1) {
                std::cerr << "close video device: "
                          << std::strerror(errno) << '\n';
            }
            video_fd = -1;
        }
    }
};

void open_device(CaptureContext& context, const std::string& device_path) {
    context.video_fd = open(
        device_path.c_str(),
        O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (context.video_fd == -1) {
        throw_errno("open " + device_path);
    }
}

void query_capabilities(const CaptureContext& context) {
    v4l2_capability capability{};
    if (xioctl(context.video_fd, VIDIOC_QUERYCAP, &capability) == -1) {
        throw_errno("VIDIOC_QUERYCAP");
    }

    // DEVICE_CAPS存在时，device_caps才描述当前打开的video节点。
    const std::uint32_t device_caps =
        (capability.capabilities & V4L2_CAP_DEVICE_CAPS)
            ? capability.device_caps
            : capability.capabilities;

    if ((device_caps & V4L2_CAP_VIDEO_CAPTURE) == 0) {
        throw std::runtime_error("当前Demo要求单平面VIDEO_CAPTURE节点");
    }
    if ((device_caps & V4L2_CAP_STREAMING) == 0) {
        throw std::runtime_error("当前节点不支持V4L2流式I/O");
    }
}

void set_format(CaptureContext& context) {
    v4l2_format format{};
    format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    format.fmt.pix.width = 1280;
    format.fmt.pix.height = 720;
    format.fmt.pix.pixelformat = V4L2_PIX_FMT_YUYV;
    format.fmt.pix.field = V4L2_FIELD_NONE;

    if (xioctl(context.video_fd, VIDIOC_S_FMT, &format) == -1) {
        throw_errno("VIDIOC_S_FMT");
    }

    // 后续所有尺寸和地址计算都使用驱动返回值，不继续使用请求值。
    const v4l2_pix_format& actual = format.fmt.pix;
    context.width = actual.width;
    context.height = actual.height;
    context.pixel_format = actual.pixelformat;
    context.bytes_per_line = actual.bytesperline;
    context.size_image = actual.sizeimage;

    std::cout << "actual format: "
              << context.width << 'x' << context.height
              << ", fourcc=" << fourcc_to_string(context.pixel_format)
              << ", bytesperline=" << context.bytes_per_line
              << ", sizeimage=" << context.size_image << '\n';

    if (context.pixel_format != V4L2_PIX_FMT_YUYV) {
        throw std::runtime_error("驱动没有接受YUYV，Demo无法解释返回数据");
    }
    if (context.width == 0 || context.height == 0 ||
        (context.width % 2) != 0) {
        throw std::runtime_error("驱动返回了无效的YUYV宽高");
    }

    const std::uint64_t valid_row_bytes =
        static_cast<std::uint64_t>(context.width) * 2;
    if (context.bytes_per_line < valid_row_bytes) {
        throw std::runtime_error("驱动返回的bytesperline小于YUYV有效行字节数");
    }
}

void request_and_map_buffers(CaptureContext& context) {
    v4l2_requestbuffers request{};
    request.count = 4;
    request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    request.memory = V4L2_MEMORY_MMAP;

    if (xioctl(context.video_fd, VIDIOC_REQBUFS, &request) == -1) {
        throw_errno("VIDIOC_REQBUFS");
    }
    context.buffers_requested = true;

    // 本Demo至少需要双缓冲；实际数量始终以驱动返回的count为准。
    if (request.count < 2) {
        throw std::runtime_error("驱动返回的MMAP缓冲区少于2个");
    }

    context.buffers.resize(request.count);
    for (std::uint32_t index = 0; index < request.count; ++index) {
        v4l2_buffer query{};
        query.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        query.memory = V4L2_MEMORY_MMAP;
        query.index = index;

        if (xioctl(context.video_fd, VIDIOC_QUERYBUF, &query) == -1) {
            throw_errno("VIDIOC_QUERYBUF");
        }

        MappedBuffer& mapped = context.buffers[index];
        mapped.length = query.length;
        mapped.address = mmap(
            nullptr,
            query.length,
            PROT_READ | PROT_WRITE,
            MAP_SHARED,
            context.video_fd,
            query.m.offset);

        if (mapped.address == MAP_FAILED) {
            throw_errno("mmap V4L2 buffer");
        }
        mapped.state = BufferState::MappedByApplication;

        std::cout << "buffer[" << index << "] mapped, length="
                  << mapped.length << '\n';
    }
}

void queue_all_and_start(CaptureContext& context) {
    for (std::uint32_t index = 0;
         index < context.buffers.size();
         ++index) {
        v4l2_buffer buffer{};
        buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        buffer.memory = V4L2_MEMORY_MMAP;
        buffer.index = index;

        if (xioctl(context.video_fd, VIDIOC_QBUF, &buffer) == -1) {
            throw_errno("initial VIDIOC_QBUF");
        }

        // QBUF成功后，buffer进入驱动可用队列，应用不得读取其中内容。
        context.buffers[index].state = BufferState::QueuedToDriver;
    }

    v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (xioctl(context.video_fd, VIDIOC_STREAMON, &type) == -1) {
        throw_errno("VIDIOC_STREAMON");
    }
    context.streaming = true;
}

void save_tight_yuyv(const CaptureContext& context,
                     const MappedBuffer& mapped,
                     std::uint32_t bytes_used,
                     const std::string& output_path) {
    const std::uint64_t row_bytes =
        static_cast<std::uint64_t>(context.width) * 2;
    const std::uint64_t last_row_end =
        static_cast<std::uint64_t>(context.height - 1) *
            context.bytes_per_line +
        row_bytes;

    // bytesused描述本帧有效范围，length描述映射边界，两者都不能越过。
    if (last_row_end > bytes_used || last_row_end > mapped.length) {
        throw std::runtime_error("当前帧不足以按驱动返回的stride读取完整YUYV图像");
    }

    std::ofstream output(output_path, std::ios::binary);
    if (!output) {
        throw std::runtime_error("无法创建输出文件: " + output_path);
    }

    const auto* base = static_cast<const std::uint8_t*>(mapped.address);
    for (std::uint32_t row = 0; row < context.height; ++row) {
        // 每行只保存width*2个有效字节，跳过源buffer的行尾padding。
        const std::uint8_t* row_begin =
            base + static_cast<std::size_t>(row) * context.bytes_per_line;
        output.write(
            reinterpret_cast<const char*>(row_begin),
            static_cast<std::streamsize>(row_bytes));
    }

    if (!output) {
        throw std::runtime_error("写入输出文件失败: " + output_path);
    }
}

void capture_frames(CaptureContext& context,
                    std::uint32_t target_frame_count,
                    const std::string& first_frame_path) {
    bool first_frame_saved = false;
    std::uint32_t captured_count = 0;

    while (captured_count < target_frame_count) {
        pollfd descriptor{};
        descriptor.fd = context.video_fd;
        descriptor.events = POLLIN;

        int poll_result;
        do {
            poll_result = poll(&descriptor, 1, 2000);
        } while (poll_result == -1 && errno == EINTR);

        if (poll_result == 0) {
            throw std::runtime_error("等待一帧超过2000毫秒");
        }
        if (poll_result == -1) {
            throw_errno("poll");
        }
        if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
            throw std::runtime_error("video设备返回poll错误事件");
        }

        v4l2_buffer dequeued{};
        dequeued.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
        dequeued.memory = V4L2_MEMORY_MMAP;

        if (xioctl(context.video_fd, VIDIOC_DQBUF, &dequeued) == -1) {
            if (errno == EAGAIN) {
                // 非阻塞模式下暂时没有完成帧，回到poll继续等待。
                continue;
            }
            throw_errno("VIDIOC_DQBUF");
        }

        if (dequeued.index >= context.buffers.size()) {
            throw std::runtime_error("驱动返回了越界的buffer index");
        }

        MappedBuffer& mapped = context.buffers[dequeued.index];
        if (mapped.state != BufferState::QueuedToDriver) {
            throw std::runtime_error("DQBUF返回的buffer不在驱动持有状态");
        }

        // DQBUF成功后，当前buffer转交应用；再次QBUF前允许读取。
        mapped.state = BufferState::DequeuedToApplication;

        const bool frame_has_error =
            (dequeued.flags & V4L2_BUF_FLAG_ERROR) != 0;
        std::cout << "buffer[" << dequeued.index << "] DRIVER -> APP"
                  << ", bytesused=" << dequeued.bytesused
                  << ", sequence=" << dequeued.sequence
                  << ", timestamp=" << dequeued.timestamp.tv_sec
                  << '.' << dequeued.timestamp.tv_usec
                  << (frame_has_error ? ", ERROR" : "") << '\n';

        if (dequeued.bytesused > mapped.length) {
            throw std::runtime_error("bytesused超过当前buffer映射长度");
        }

        // 错误帧仍需归还，但不保存为示例图片数据。
        if (!frame_has_error && !first_frame_saved) {
            save_tight_yuyv(
                context,
                mapped,
                dequeued.bytesused,
                first_frame_path);
            first_frame_saved = true;
            std::cout << "saved " << first_frame_path << '\n';
        }

        if (xioctl(context.video_fd, VIDIOC_QBUF, &dequeued) == -1) {
            throw_errno("VIDIOC_QBUF after processing");
        }

        // QBUF成功后DMA可以再次覆盖该buffer，后续代码不得继续读取mapped.address。
        mapped.state = BufferState::QueuedToDriver;
        std::cout << "buffer[" << dequeued.index
                  << "] APP -> DRIVER (QBUF)\n";

        ++captured_count;
    }
}

int main(int argc, char** argv) {
    const std::string device_path =
        argc > 1 ? argv[1] : "/dev/video0";

    CaptureContext context;
    try {
        open_device(context, device_path);
        query_capabilities(context);
        set_format(context);
        request_and_map_buffers(context);
        queue_all_and_start(context);
        capture_frames(context, 100, "first-frame.yuyv");

        // 显式清理便于观察顺序；发生异常时析构函数执行同一套清理。
        context.cleanup();
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "capture failed: " << error.what() << '\n';
        return 1;
    }
}
```

保存为`v4l2_mmap_capture.cpp`后编译运行：

```bash
g++ -std=c++17 -Wall -Wextra -O2 \
  v4l2_mmap_capture.cpp -o v4l2_mmap_capture

./v4l2_mmap_capture /dev/video0
```

程序会打印驱动最终返回的格式、每个映射长度，以及同一buffer在`DRIVER → APP → DRIVER`之间循环的日志。第一帧已经按实际`bytesperline`逐行去除padding，可转换为PNG；宽高必须替换为程序打印的实际值：

```bash
ffmpeg -f rawvideo \
  -pixel_format yuyv422 \
  -video_size 1280x720 \
  -i first-frame.yuyv \
  -frames:v 1 first-frame.png
```
