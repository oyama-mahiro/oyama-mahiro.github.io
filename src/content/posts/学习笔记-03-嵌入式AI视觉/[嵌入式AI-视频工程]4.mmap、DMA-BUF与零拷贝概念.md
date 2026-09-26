---
title: '[嵌入式AI-视频工程] mmap、DMA-BUF与零拷贝概念'
published: 2026-09-24T08:11:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍mmap、DMA-BUF与零拷贝概念的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-4 mmap、DMA-BUF与零拷贝概念

在嵌入式图像处理、硬件编码、GPU渲染与显示输出中，一块图像缓冲区通常要被多个硬件模块依次使用。例如摄像头把图像写入内存，RGA读取图像并完成缩放，NPU再读取处理后的数据，最后由编码器或显示模块使用结果。

理解这条数据路径，需要先从最简单的情况开始：一个设备如何取得并访问一块物理内存。然后再看这块内存如何通过DMA-BUF交给另一个设备，最后解释DMA API、DMA硬件、IOMMU和零拷贝之间容易混淆的关系。

```text
单设备物理内存分配与地址映射
→ DMA-BUF跨设备共享同一块内存
→ DMA、IOMMU、缓存同步与零拷贝的底层关系
```

## 1 单设备物理内存的分配与IOMMU映射流程

当一个硬件设备需要使用一块图像内存时，整个过程可以分为两个阶段：

- **软件准备阶段：**CPU执行用户程序、系统调用和设备驱动，完成物理页分配、DMA地址映射及硬件参数配置。此时硬件DMA还没有开始搬运数据。
- **硬件传输阶段：**驱动启动设备后，设备才使用DMA地址发起总线读写；如果启用了IOMMU，IOMMU硬件会实时进行地址翻译，最终访问DDR。

### 1.1 单设备使用内存的总体流程

以RGA处理一张图像为例，完整流程如下：

```text
用户程序向RGA提交任务
→ CPU进入RGA驱动
→ 驱动取得保存图像的物理页
→ 驱动调用Linux DMA API为RGA准备DMA地址
→ 如果RGA启用了IOMMU，CPU执行IOMMU建表代码，建立IOVA到物理页的映射
→ RGA驱动把DMA地址、图像大小、格式和stride写入任务描述符或寄存器
→ RGA驱动启动硬件
→ RGA硬件使用DMA地址发起读写请求
→ IOMMU硬件把IOVA实时翻译为物理地址
→ DDR完成实际数据读写
→ RGA通过中断或完成信号通知驱动
```

这个总流程中有三个不同动作，不能混为一谈：

```text
分配缓冲区：决定由哪些物理页保存数据
建立CPU映射：让程序可以通过指针访问这些物理页
建立DMA映射：让指定硬件设备获得可访问这些物理页的DMA地址
```

一块缓冲区可以只供设备使用，此时不一定需要映射到用户进程；也可以同时建立CPU映射和设备DMA映射，让程序与设备在不同时间访问同一批物理页。

### 1.2 软件准备阶段：CPU完成分配、映射与设备配置

软件准备阶段虽然包含DMA和IOMMU相关函数，但执行这些函数的仍然是CPU。可以继续拆成四步。

**第1步：驱动取得物理内存页**

DDR只是实际保存数据的存储硬件。DDR控制器负责把物理地址转换成通道、Bank、行和列，并产生具体的读写命令，但DDR并不知道某段地址属于内核、进程、摄像头还是RGA。

Linux启动时会从Bootloader、Device Tree和启动参数中取得可用DDR物理地址范围，然后记录每个物理页是否空闲、是否可移动以及当前由谁使用。因此，Linux中的“分配物理内存”并不是向DDR发送“申请空间”的命令，而是：

```text
Linux检查自己记录的空闲物理页
→ 选择满足大小、连续性和地址范围要求的页
→ 把这些页标记为正在使用
→ 返回描述这些页面的内核对象
```

运行期间常见的物理页来源包括：

- **Buddy伙伴系统：**Linux最主要的普通物理页分配器。它按照不同阶数管理连续空闲页块，可以拆分和合并。普通进程内存、文件页缓存以及很多驱动缓冲区最终都可能从这里取得页面。
- **CMA（Contiguous Memory Allocator，连续内存分配器）：**用于整理出较大的物理连续区域。当设备没有IOMMU、不支持分散地址，或者驱动明确要求连续物理内存时，常使用CMA。
- **reserved-memory：**通过Device Tree提前保留固定物理地址，使其不进入普通Buddy分配，常用于固件、安全内存或具有固定地址要求的硬件。

Buddy、CMA和reserved-memory的区别只存在于Linux如何管理和选择物理地址。对DDR来说，这些页面都只是可以被读写的物理地址，没有不同的DDR分配协议。

程序通常不会直接调用Buddy或CMA，而是先打开某个设备节点，再通过该设备规定的ioctl申请缓冲区。例如：

```text
/dev/dri/card0       → DRM接口创建GEM显示缓冲区
/dev/video0          → V4L2接口创建采集缓冲区
/dev/dma_heap/system → DMA-HEAP接口按system heap策略创建共享缓冲区
```

这些设备文件并不是物理内存本身。`open()`返回的fd只是当前进程fd表中的整数索引，内核通过fd找到对应的文件对象和驱动操作。驱动收到ioctl后，才根据自己的实现选择Buddy、CMA或其他内存后端。

驱动分配成功后不一定直接得到一个裸物理地址。根据接口不同，它可能得到CPU内核地址、`struct page`页面对象或`struct sg_table`分散聚集表。SG表用于描述一组可能不连续的物理页及其长度：

```text
SG项0 → 物理页A，长度4096字节
SG项1 → 物理页B，长度8192字节
SG项2 → 物理页C，长度4096字节
```

这也说明了三种“连续”不是同一个概念：

- **CPU虚拟地址连续：**程序可以使用一个连续指针范围访问数据，背后的物理页可以分散。
- **物理地址连续：**物理页在DDR地址空间中相邻，CMA常用于满足这种要求。
- **设备地址连续：**有IOMMU时，可以把分散物理页映射成一段连续IOVA供设备使用。

**第2步：驱动调用DMA API为目标设备准备地址**

物理页准备完成后，设备驱动会调用Linux通用DMA API，例如`dma_map_sgtable()`，并传入目标设备对应的`struct device`。DMA API的任务不是启动硬件，而是根据这个设备的寻址能力和IOMMU配置，生成设备能够使用的`dma_addr_t`。

```text
CPU执行设备驱动
→ 驱动把页面或SG表以及目标struct device交给DMA API
→ DMA层检查该设备的DMA mask、IOMMU配置和平台地址转换规则
→ 返回该设备可用的DMA地址
```

这里之所以必须传入`struct device`，是因为同一批物理页交给RGA、VOP或其他设备时，设备可访问的地址范围和IOMMU地址空间可能不同。DMA映射不是只根据“这块内存在哪里”决定，还要根据“哪个设备准备访问它”决定。

**第3步：启用IOMMU时，由CPU执行IOMMU建表代码**

IOMMU（Input-Output Memory Management Unit，输入输出内存管理单元）负责把设备使用的I/O虚拟地址IOVA翻译成物理地址。设备驱动并不是直接拿一个物理地址调用硬件IOMMU，而是调用通用DMA API；DMA层发现该设备连接并启用了IOMMU后，再进入IOMMU子系统和具体IOMMU驱动。

```text
DMA API收到页面和目标设备
→ IOMMU层在该设备所属IOMMU Domain中寻找可用IOVA范围
→ CPU把IOVA到物理页的对应关系写入IOMMU页表
→ CPU刷新必要的IOMMU地址转换缓存
→ DMA API把生成的IOVA作为dma_addr_t返回给设备驱动
```

IOMMU Domain表示一套设备地址空间及其映射关系，但不一定由一个设备独占。不同设备可能属于不同Domain，也可能共享同一个Domain。IOVA分配器如何记录空闲范围属于内核实现细节。

CPU使用的MMU也有页表，但它与IOMMU页表不是同一张表：

```text
程序指针 → CPU虚拟地址 → CPU MMU和进程页表 → 物理地址 → DDR

设备DMA地址 → IOMMU和设备所属Domain页表 → 物理地址 → DDR
```

CPU进程页表用于让程序通过指针访问内存；IOMMU页表用于让设备通过IOVA访问内存。同一批物理页可以同时被两套页表映射，但CPU虚拟地址和设备IOVA通常不同。

普通匿名内存可以采用按需分配：进程第一次访问某个合法但尚未建立页面的虚拟地址时触发缺页异常，内核再补充分配和CPU页表。设备DMA通常不能依靠这种方式临时补页。驱动必须在启动硬件前准备好DMA映射，否则设备访问未映射或越界IOVA时会产生IOMMU fault。

**第4步：驱动配置硬件任务**

DMA API返回地址后，设备驱动会把地址、长度、访问方向以及设备自己的任务参数写入寄存器或任务描述符。以RGA为例，除了源地址和目标地址，还需要写入宽高、像素格式、stride和裁剪区域。

```text
DMA地址只解决“设备去哪里读写”
格式、宽高、stride和offset决定“设备具体读写多少以及怎样解释数据”
```

即使IOVA映射本身正确，错误的stride、offset或图像高度仍然可能让硬件访问到映射范围之外，最终表现为IOMMU fault。

### 1.3 硬件传输阶段：DMA发起读写并由IOMMU实时翻译

软件准备完成后，硬件DMA仍然没有开始工作。硬件传输阶段可以继续拆成四步。

**第1步：驱动启动设备**

驱动写入任务参数后，再设置设备的启动位、提交任务描述符或更新硬件队列。只有执行这一步，设备才开始处理任务。不同设备的启动方式不同，不一定都存在一个名字恰好为`START`的寄存器，但本质都是驱动通知硬件任务已经准备完成。

**第2步：设备发起总线读写请求**

RGA、GPU、VOP等模块通常能够作为总线主设备主动访问内存。设备使用驱动写入的DMA地址，沿SoC内部总线发出读写请求。此时真正搬运图像数据的是设备硬件，而不是执行`dma_map_sgtable()`的CPU。

需要注意，并不是所有外设都必须各自拥有一个完全独立的DMA控制器。有些多媒体模块本身能够主动访问内存，有些普通外设则借助系统中的通用DMAC。是否使用DMA以及使用哪种DMA结构，由SoC硬件设计和驱动共同决定。

**第3步：IOMMU硬件实时翻译IOVA**

如果该设备的总线路径经过并启用了IOMMU，设备发出的地址是IOVA。IOMMU硬件根据之前由CPU建立的页表，将IOVA翻译成物理地址，再把请求送往内存系统。

```text
RGA发出IOVA读写请求
→ IOMMU硬件查询RGA所属Domain的页表
→ 得到对应物理地址
→ 把访问请求继续发送给DDR控制器
```

这一步发生在硬件真正访问内存时。CPU只负责提前建立页表，不会在每一次DMA访问中替设备查询和转换地址。

**第4步：DDR完成读写并由设备报告完成**

DDR控制器接收到物理地址后完成实际读写。任务结束时，设备通常通过中断、状态寄存器或fence通知驱动。驱动收到完成状态后，才可以把结果交给用户程序或下一个设备。

### 1.4 mmap如何把不同对象映射为CPU虚拟地址

如果缓冲区只在硬件设备之间传递，用户程序不一定需要访问其中的像素。如果程序需要读取或修改内容，就要把对应页面映射到进程的CPU虚拟地址空间，`mmap()`通常用于完成这个动作。

`mmap()`不只用于DMA-BUF，它还可以映射匿名内存、普通文件、共享内存、V4L2缓冲区以及其他设备缓冲区。它并不是把这些对象直接“转换成物理地址指针”，而是先在当前进程中建立一段虚拟地址区域，并记录：程序访问这段虚拟地址时，应该从哪个对象中取得对应页面。

这些对象本身通常不是物理地址，而是管理数据和页面的内核对象。

**mmap首先创建VMA并记录映射规则**

`mmap()`声明在`<sys/mman.h>`中：

```cpp
#include <sys/mman.h>

void* mmap(void* address, size_t length, int protection,
           int flags, int fd, off_t offset);
int munmap(void* address, size_t length);
```

调用`mmap()`后，内核首先在当前进程的虚拟地址空间中创建VMA（Virtual Memory Area，虚拟内存区域）。VMA主要记录：

```text
虚拟地址范围
读、写和执行权限
MAP_SHARED或MAP_PRIVATE
关联的文件、共享内存或设备对象
对象中的起始offset
发生缺页时应该如何找到对应页面
```

`mmap()`返回的是这段VMA的起始虚拟地址。此时物理页和CPU页表可能处于三种状态：

- 页面和页表项都还没有创建，要等第一次访问时处理；
- 页面已经存在，但CPU页表要等缺页时再建立；
- 驱动在`mmap()`回调中直接把已有页面或设备物理地址映射进页表。

所以不能一概认为所有`mmap()`都一定等到第一次访问才建立映射，但普通文件和匿名内存会大量使用按需缺页机制。

**程序访问VMA后如何找到物理页**

如果程序访问某个虚拟地址，而CPU的MMU没有找到有效页表项，就会触发缺页异常。内核根据该虚拟地址找到对应VMA，再按照VMA记录的对象和处理方式取得页面：

```text
程序调用mmap()
→ 内核创建VMA并记录映射规则
→ mmap()返回虚拟地址

程序第一次访问虚拟地址
→ MMU没有找到有效页表项
→ CPU触发缺页异常
→ 内核根据虚拟地址找到VMA
→ 根据VMA找到对应文件、共享内存或设备对象
→ 取得、读取或分配对应物理页
→ 内核把“虚拟地址→物理页”写入CPU页表
→ CPU重新执行刚才的访问
```

这里的“取得页面”会因对象不同而不同：

```text
匿名内存 → 内核分配新的匿名物理页
普通文件 → 从页缓存取得文件对应的物理页
共享内存 → 从共享内存对象取得共享物理页
V4L2缓冲区 → 从V4L2 buffer管理对象取得缓冲区页面
DMA-BUF → 从struct dma_buf及其导出者取得后备页面
```

最后写入CPU页表的都是页面或物理页帧信息，但前面的文件对象、V4L2 buffer和`struct dma_buf`本身都不是物理地址。

**页缓存、V4L2 buffer页面和DMA缓冲区页面的关系**

页缓存页面、V4L2 buffer页面和DMA缓冲区页面最终都可能是DDR中的普通物理页。它们的区别主要是由谁管理、保存什么数据以及通过什么对象找到，并不是三种不同的DDR硬件。

```text
普通文件对象 → 页缓存 → 页缓存中的物理页
V4L2 buffer对象 → videobuf2内存后端 → 采集缓冲区物理页
struct dma_buf → DMA-BUF导出者 → 共享缓冲区物理页
```

页缓存不是一个物理地址，而是Linux使用物理内存缓存文件内容的一套机制。假设程序访问文件的第0～4095字节：

```text
CPU访问文件映射的第一页
→ 触发缺页异常
→ 内核查找“文件A的第0页”是否已经在页缓存中
→ 已存在：直接取得对应页缓存页
→ 不存在：分配物理页，并从磁盘读取对应文件内容
→ 页缓存记录“这个物理页保存文件A的第0页”
→ 内核把该物理页加入进程页表
```

因此要区分页缓存、页缓存页和物理地址：页缓存是管理机制；页缓存页是实际保存某段文件内容的物理页；物理地址是该物理页在DDR地址空间中的位置。`open()`不会把整个文件立即读入内存，`mmap()`也不会一次性复制整个文件。一般是程序访问到哪一页，内核再按需把对应文件内容读入页缓存。

V4L2 buffer同样不是物理地址，而是V4L2内核中的缓冲区管理对象。它记录或关联缓冲区编号、大小、状态、有效数据长度、时间戳、内存后端以及保存图像的页面。可以把它理解成一份采集缓冲区档案：

```text
V4L2 buffer管理对象
→ 通过videobuf2内存后端找到缓冲区页面
→ 页面实际保存摄像头采集的图像
```

**驱动的mmap回调与缺页回调**

驱动注册设备时，会向内核提供一组文件操作函数，其中可以包含`mmap`函数。概念上类似：

```c
static const struct file_operations device_operations = {
    .open = device_open,
    .unlocked_ioctl = device_ioctl,
    .mmap = device_mmap,   // 程序对设备fd调用mmap时，内核调用该函数。
};
```

`device_mmap()`就是驱动的`mmap`回调。回调表示驱动提前把函数地址注册给内核，等用户程序执行对应操作时再由内核调用：

```text
驱动注册device_mmap()
→ 程序对设备fd调用mmap()
→ 内核发现fd属于该驱动
→ 内核回调device_mmap()
```

驱动的`mmap`回调通常有两种处理方式。

第一种是在`mmap`回调中立即建立映射：

```text
驱动mmap回调
→ 根据offset找到缓冲区
→ 使用remap_pfn_range()等内核接口
→ 直接把物理页帧或设备地址映射到VMA
```

第二种是先给VMA注册缺页处理函数，等程序访问时再映射具体页面：

```text
驱动mmap回调
→ 在VMA中记录缓冲区对象
→ 注册vm_ops->fault缺页回调
→ 程序以后访问虚拟地址
→ 缺页异常触发fault回调
→ fault回调取得对应页面
→ 内核补充CPU页表
```

因此需要区分两个回调：文件操作中的`mmap`回调在调用`mmap()`系统调用时执行，用于检查参数并配置VMA；VMA中的`fault`回调在程序以后访问缺页地址时执行，用于取得具体页面。驱动可以在`mmap`回调中直接映射全部页面，也可以通过`fault`回调按需映射。

**常见对象的mmap使用方法**

匿名映射没有关联文件或设备对象，通常在第一次写入时才由内核分配匿名物理页：

```cpp
size_t length = 4096;

void* address = mmap(
    nullptr,
    length,
    PROT_READ | PROT_WRITE,
    MAP_PRIVATE | MAP_ANONYMOUS,
    -1,             // MAP_ANONYMOUS不使用fd。
    0
);

if (address == MAP_FAILED) {
    // 没有取得有效虚拟地址，调用者不能继续访问该区域。
    perror("mmap anonymous");
}
```

普通文件映射通过文件fd和offset确定文件区域，程序访问时再从页缓存取得对应页面：

```cpp
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

int file_fd = open("data.bin", O_RDWR);
struct stat file_info = {};

if (file_fd >= 0 && fstat(file_fd, &file_info) == 0) {
    void* address = mmap(
        nullptr,
        file_info.st_size,
        PROT_READ | PROT_WRITE,
        MAP_SHARED,       // 修改共享页缓存后，可以把脏页写回原文件。
        file_fd,
        0
    );

    if (address != MAP_FAILED) {
        // 请求把修改后的脏页同步回文件，然后解除当前进程的映射。
        msync(address, file_info.st_size, MS_SYNC);
        munmap(address, file_info.st_size);
    }
}

close(file_fd);
```

`MAP_SHARED`写入的是共享文件页缓存，修改可以写回文件；`MAP_PRIVATE`采用写时复制，写入后通常得到当前进程自己的匿名页，不直接修改原文件。

POSIX共享内存使用`shm_open()`取得fd，再用`mmap()`把同一个共享对象映射进不同进程：

```cpp
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>

constexpr size_t shared_size = 4096;
int shared_fd = shm_open("/frame_metadata", O_CREAT | O_RDWR, 0600);

// 新创建的共享内存对象大小为0，需要先设置容量。
if (shared_fd >= 0 && ftruncate(shared_fd, shared_size) == 0) {
    void* address = mmap(
        nullptr,
        shared_size,
        PROT_READ | PROT_WRITE,
        MAP_SHARED,
        shared_fd,
        0
    );

    if (address != MAP_FAILED) {
        munmap(address, shared_size);
    }
}

close(shared_fd);
shm_unlink("/frame_metadata");
```

不同进程可以使用不同虚拟地址映射同一个共享内存对象，最终指向同一批共享物理页。System V共享内存使用的是`shmget()`、`shmat()`和`shmdt()`，并不是直接调用`mmap()`。

V4L2先通过`VIDIOC_QUERYBUF`取得驱动返回的缓冲区长度和offset，再对设备fd执行映射：

```cpp
void* frame_address = mmap(
    nullptr,
    query_buffer.length,
    PROT_READ | PROT_WRITE,
    MAP_SHARED,
    video_fd,                  // /dev/video0对应的fd。
    query_buffer.m.offset      // 驱动使用offset识别具体V4L2 buffer。
);

if (frame_address == MAP_FAILED) {
    // 只表示CPU映射失败，不代表V4L2缓冲区没有分配成功。
    perror("mmap V4L2 buffer");
}
```

内部流程为：

```text
程序对video_fd调用mmap()
→ 内核通过fd找到V4L2设备文件对象
→ 内核调用V4L2驱动注册的mmap回调
→ V4L2根据offset找到对应的V4L2 buffer
→ videobuf2内存后端找到该buffer关联的页面
→ 驱动立即映射页面，或者给VMA注册后续缺页处理函数
→ CPU页表建立“虚拟地址→缓冲区页面”的映射
→ 程序通过返回的指针访问采集图像
```

V4L2中的offset主要用于让驱动识别具体buffer，并不一定表示普通文件中的字节位置。

DMA-BUF通过`dma_buf_fd`找到内核中的`struct dma_buf`和导出者：

```cpp
void* buffer_address = mmap(
    nullptr,
    buffer_size,
    PROT_READ | PROT_WRITE,
    MAP_SHARED,
    dma_buf_fd,
    0
);

if (buffer_address == MAP_FAILED) {
    // 导出者可能不支持CPU映射，或者映射长度、权限不合法。
    perror("mmap DMA-BUF");
}
```

内部流程为：

```text
dma_buf_fd
→ 找到struct dma_buf
→ DMA-BUF核心调用导出者的mmap回调
→ 导出者找到缓冲区的后备页面
→ 把页面映射到当前进程
```

`struct dma_buf`同样不是物理地址。它是DMA-BUF框架中的共享缓冲区对象，其中记录导出者、回调、大小、引用和同步信息，并能够通过导出者找到真正的后备页面。不是所有DMA-BUF都允许CPU映射，例如安全缓冲区或设备专用缓冲区可以拒绝`mmap()`。

还要区分DMA-BUF的两种映射：

```text
mmap(dma_buf_fd)
→ 建立CPU虚拟地址到后备页面的映射
→ 让程序通过指针访问

dma_buf_map_attachment()
→ 针对某个硬件设备建立DMA地址映射
→ 让设备通过DMA地址访问
```

与`mmap()`经常配合使用的接口包括：`munmap()`用于解除当前进程的虚拟地址映射；`msync()`用于请求同步文件共享映射中的脏页；`mprotect()`用于修改映射区域的读写执行权限；`madvise()`用于向内核说明顺序访问、随机访问或不再需要等访问特点；`ftruncate()`用于设置文件或POSIX共享内存对象的大小。

**如何判断一个fd能否被mmap**

fd本身没有一个用户空间可见的“允许mmap”标志。是否支持映射，取决于fd背后的内核对象或驱动是否提供了`mmap`操作，以及本次传入的权限、offset和长度是否符合要求。

```text
程序对fd调用mmap()
→ 内核通过进程fd表找到struct file
→ 检查该文件对象关联的file_operations
→ 存在mmap回调：调用该回调检查并建立映射
→ 不存在mmap回调或回调拒绝：mmap失败
```

用户程序一般不能直接查看内核中的`file_operations`，实际判断主要依靠接口文档和fd的来源：

```text
open()打开普通文件                  → 通常支持mmap
shm_open()或memfd_create()返回的fd   → 支持mmap
V4L2在VIDIOC_QUERYBUF后提供offset    → 对应MMAP缓冲区可以mmap
DRM驱动提供mmap offset              → 按DRM接口进行mmap
DMA-BUF fd                           → 是否支持由导出者决定
socket、pipe和epoll fd               → 通常不支持mmap
```

最终仍应实际调用并检查返回值：

```cpp
void* address = mmap(
    nullptr,
    length,
    PROT_READ | PROT_WRITE,
    MAP_SHARED,
    fd,
    offset
);

if (address == MAP_FAILED) {
    // ENODEV常表示对象不支持mmap；EINVAL常表示参数或offset不合法；
    // EACCES表示fd打开权限与映射权限不匹配，ENOMEM表示无法创建映射。
    perror("mmap");
}
```

整套机制可以概括为：

```text
mmap()阶段：
根据fd、offset和flags找到对象
→ 创建VMA
→ 调用文件或驱动的mmap回调
→ 立即建立映射，或者记录后续缺页处理方式

CPU访问阶段：
MMU查询CPU页表
→ 页表项不存在时触发缺页异常
→ 内核根据VMA找到对应对象
→ 对象提供、读取或分配实际页面
→ 内核建立CPU虚拟地址到物理页的映射
→ CPU重新执行访问
```

页缓存、V4L2 buffer和`struct dma_buf`都是帮助内核管理或找到页面的不同对象或机制，本身都不是裸物理地址。`mmap()`负责建立CPU访问路径，不负责给设备建立IOVA，也不会启动DMA；反过来，已经完成DMA映射的缓冲区也不一定已经映射到用户进程。

## 2 跨设备访问同一物理空间与DMA-BUF零拷贝共享

在`摄像头采集 → RGA缩放 → DRM显示`这类流水线中，如果每经过一个模块就由CPU执行一次`memcpy()`，不仅占用CPU，还会增加DDR读写带宽。零拷贝的核心不是不访问DDR，而是让不同设备直接访问同一块或同一组缓冲区，避免为了传递数据额外复制出一份完整图像。

### 2.1 跨设备共享内存的总体流程

不同驱动内部使用自己的缓冲区对象。例如DRM使用GEM对象和GEM handle，V4L2使用buffer index，RGA又有自己的导入句柄。RGA无法直接识别DRM文件上下文中的GEM handle，因此需要Linux统一规定的DMA-BUF共享缓冲区框架作为中间桥梁。

```text
DRM创建GEM缓冲区并取得后备物理页
→ DRM按照DMA-BUF框架把GEM对象导出为dma_buf_fd
→ 用户程序把dma_buf_fd交给RGA
→ RGA驱动通过fd找到内核中的struct dma_buf
→ RGA把该dma_buf attach到RGA对应的struct device
→ dma_buf_map_attachment()调用DRM导出者的映射回调
→ DRM导出者通过DMA API为RGA准备可用的DMA地址
→ RGA得到已经针对自己映射好的sg_table
→ RGA驱动配置地址并启动硬件
→ RGA直接读写原DRM缓冲区的后备页面
```

这个流程没有重新创建第二份图像数据。变化的是“同一批物理页又获得了一个可供RGA使用的DMA映射”，不是“把DRM内存复制成RGA内存”。

### 2.2 导出DMA-BUF并在用户空间传递fd

DMA-BUF中的缓冲区提供者称为导出者（Exporter），使用缓冲区的另一个设备称为导入者（Importer）。导出者仍然负责实际后备存储的分配、释放和页面组织方式，同时按照DMA-BUF框架实现映射、解除映射和CPU访问等回调。

导出时，驱动调用DMA-BUF核心提供的接口创建`struct dma_buf`，内核再为这个对象安装一个fd。用户程序看到的`dma_buf_fd`仍然只是进程fd表中的一个整数索引：

```text
dma_buf_fd
→ 当前进程fd表中的一项
→ 对应内核file对象
→ 对应struct dma_buf
→ struct dma_buf关联导出者、回调、后备存储和同步信息
```

因此，fd不是物理内存，也不包含物理地址。它只是让用户程序能够保存、复制和传递对内核DMA-BUF对象的引用。通过Unix域套接字传递fd时，接收进程会得到一个新的fd编号，但两个fd仍然引用同一个DMA-BUF对象。

普通`malloc()`、Buddy页面或CMA内存不会自动变成DMA-BUF。只有内存所有者实现DMA-BUF导出操作，或者使用DRM PRIME、V4L2 videobuf2、DMA-HEAP等已经接入DMA-BUF的框架，用户空间才能得到`dma_buf_fd`。

### 2.3 导入设备通过attachment取得自己的DMA地址

RGA驱动拿到用户传入的fd后，先通过DMA-BUF核心找到对应的`struct dma_buf`。随后调用`dma_buf_attach()`，把这个共享缓冲区与RGA的`struct device`建立关联，生成`struct dma_buf_attachment`。

attachment的关键作用是明确：

```text
哪一个DMA-BUF
→ 准备交给哪一个设备使用
```

然后RGA驱动调用`dma_buf_map_attachment()`。DMA-BUF核心会进入导出者实现的`map_dma_buf`回调。以DRM为导出者时，DRM驱动根据GEM对象找到后备页面并形成SG表，再通过DMA API针对attachment中记录的RGA设备完成DMA映射。

```text
RGA调用dma_buf_map_attachment()
→ DMA-BUF核心找到DRM提供的map_dma_buf回调
→ DRM根据GEM对象准备后备页面和SG表
→ DMA API以RGA的struct device为目标执行DMA映射
→ 有IOMMU时，在RGA所属地址空间建立IOVA到物理页的映射
→ 返回包含RGA可用DMA地址的sg_table
```

这里需要修正一个容易产生误解的说法：`dma_buf_map_attachment()`不是先简单返回一份裸物理地址，然后由RGA驱动在外面另行调用IOMMU建表。按照DMA-BUF接口约定，导出者的`map_dma_buf`回调返回的SG表已经针对`attachment->dev`完成DMA映射。RGA驱动从中使用`sg_dma_address()`和`sg_dma_len()`取得设备地址和长度。

IOMMU也不会在DRM给出页面后自动知道应该给RGA建表。真正触发建表的是CPU执行上述映射调用；attachment中保存的RGA设备信息告诉DMA/IOMMU层应该为哪个设备地址空间建立映射。

为什么不能只传一个物理地址？因为一个物理地址无法完整说明：

- 缓冲区可能由多段不连续物理页组成；
- 每段页面的长度和偏移是多少；
- 哪个驱动拥有并负责释放这些页面；
- 导入设备能否访问这些地址；
- 应该针对哪个设备建立DMA映射；
- 上一个设备是否已经完成写入。

DMA-BUF不仅传递页面信息，还通过引用计数、attachment、映射回调以及同步对象组织跨驱动使用规则。

### 2.4 V4L2采集缓冲区导出为DMA-BUF

V4L2使用`V4L2_MEMORY_MMAP`模式时，程序先通过`VIDIOC_REQBUFS`请求采集缓冲区。V4L2核心进入驱动配置的videobuf2队列和内存后端，由内存后端选择实际物理页来源并创建V4L2 buffer对象。

相关V4L2类型和ioctl命令定义在`<linux/videodev2.h>`中，`ioctl()`声明在`<sys/ioctl.h>`中。下面只保留与缓冲区分配和导出有关的调用。

```cpp
struct v4l2_requestbuffers request = {};
request.count = 4;                         // 创建4个循环使用的采集缓冲区。
request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
request.memory = V4L2_MEMORY_MMAP;         // 缓冲区由V4L2驱动及其内存后端分配。

if (ioctl(video_fd, VIDIOC_REQBUFS, &request) < 0) {
    // 失败后没有可查询、入队或导出的缓冲区，调用者必须停止后续流程。
    perror("VIDIOC_REQBUFS");
}
```

内核中的分配路径大致为：

```text
VIDIOC_REQBUFS
→ V4L2核心
→ 驱动的videobuf2队列
→ 驱动选择的内存后端
→ 从普通页面、连续DMA内存或其他来源取得后备页面
→ 创建V4L2 buffer对象
```

程序若需要通过CPU读取图像，可以使用`VIDIOC_QUERYBUF`取得offset和长度，再对`/dev/video0`执行`mmap()`。这个映射只建立CPU访问路径，并不是导出DMA-BUF。

如果需要把同一个采集缓冲区交给RGA或编码器，则执行`VIDIOC_EXPBUF`：

```cpp
struct v4l2_exportbuffer export_buffer = {};
export_buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
export_buffer.index = 0;          // 导出已经分配好的第0个MMAP采集缓冲区。
export_buffer.flags = O_CLOEXEC;  // exec新程序时自动关闭fd，避免无意泄漏。

if (ioctl(video_fd, VIDIOC_EXPBUF, &export_buffer) < 0) {
    // 可能是队列不是MMAP模式，或当前驱动的内存后端不支持DMA-BUF导出。
    perror("VIDIOC_EXPBUF");
}

int dma_buf_fd = export_buffer.fd; // 该fd引用原V4L2缓冲区，没有复制图像。
```

`VIDIOC_EXPBUF`进入videobuf2的DMA-BUF导出路径，为已有缓冲区创建DMA-BUF引用。是否支持导出取决于具体驱动和内存后端，并非所有V4L2队列都一定支持。

### 2.5 DRM缓冲区通过DMA-BUF交给RGA

DRM调用`DRM_IOCTL_MODE_CREATE_DUMB`后，驱动创建GEM对象并为它准备后备存储。返回的GEM handle只是当前DRM文件上下文中的对象编号，既不是物理地址，也不是可供RGA直接使用的通用fd。

程序通过DRM PRIME把GEM对象导出为DMA-BUF fd：

```cpp
struct drm_mode_create_dumb create = {};
create.width = width;
create.height = height;
create.bpp = 32;

int dma_buf_fd = -1;
if (ioctl(drm_fd, DRM_IOCTL_MODE_CREATE_DUMB, &create) < 0) {
    // 创建失败时没有有效GEM handle，不能继续执行PRIME导出。
    perror("DRM_IOCTL_MODE_CREATE_DUMB");
} else if (drmPrimeHandleToFD(drm_fd, create.handle, DRM_CLOEXEC,
                              &dma_buf_fd) != 0) {
    // GEM对象仍归DRM管理，但本次没有取得跨驱动共享所需的DMA-BUF fd。
    perror("drmPrimeHandleToFD");
}
```

PRIME导出不会重新分配或复制物理页面。GEM handle与DMA-BUF fd只是通过不同接口引用同一个GEM对象及其后备存储。

程序随后把`dma_buf_fd`传给librga的`importbuffer_fd()`。用户态库再把fd交给RGA驱动，RGA驱动按照2.3节说明的attachment和map流程取得自己的DMA地址：

```cpp
rga_buffer_handle_t rga_handle =
    importbuffer_fd(dma_buf_fd, width, height, format);

if (rga_handle == 0) {
    // fd无效、格式属性不兼容或内核DMA映射失败时，不能继续提交RGA任务。
    std::cerr << "importbuffer_fd failed\n";
}
```

完整过程是：

```text
DRM创建GEM对象和后备页面
→ PRIME把GEM对象导出为dma_buf_fd
→ librga把fd提交给RGA驱动
→ RGA驱动取得struct dma_buf并attach到RGA设备
→ DRM导出回调为RGA返回已完成DMA映射的sg_table
→ RGA驱动从SG表取得DMA地址
→ RGA驱动填写源地址、目标地址、格式、宽高和stride
→ RGA硬件启动并直接访问原DRM缓冲区
```

同一批物理页可以同时映射给显示设备和RGA。如果它们属于不同IOMMU Domain，可以使用不同IOVA指向相同物理页；如果共享Domain，内核会统一管理IOVA范围。地址映射本身不会冲突，真正需要协调的是哪个设备先写、哪个设备后读以及缓冲区何时可以复用。

### 2.6 零拷贝中的缓存同步、完成顺序与生命周期

DMA-BUF共享避免的是为了交给下一个设备而执行的额外CPU复制，并不消除设备本身对DDR的读写。RGA进行缩放时仍然要从源缓冲区读取数据并写入目标缓冲区。

```text
存在CPU复制：V4L2缓冲区 → memcpy → CPU中间缓冲区 → RGA

DMA-BUF共享：V4L2缓冲区 → 同一个DMA-BUF → RGA
```

共享同一块内存后还要解决缓存一致性。CPU写入的数据可能仍停留在CPU Cache中；设备DMA写入以后，CPU Cache中也可能保留旧数据。是否需要显式同步取决于SoC一致性能力、缓冲区属性和驱动实现。用户空间对DMA-BUF进行CPU访问时，某些平台要求使用`DMA_BUF_IOCTL_SYNC`或厂商同步接口包围CPU读写。`mmap()`成功只代表指针可用，不代表缓存状态一定正确。

还要保证设备执行顺序。摄像头写完一帧后RGA才能读取，RGA写完后NPU、编码器或显示模块才能读取结果。异步设备通过中断、fence、sync_file或厂商任务接口报告完成。

```text
V4L2完成写入并DQBUF
→ RGA读取该缓冲区
→ 等待RGA完成
→ 下游使用RGA结果
→ 原采集缓冲区不再被读取后，才能重新QBUF给摄像头
```

如果RGA尚未完成就把V4L2缓冲区重新入队，摄像头可能覆盖RGA正在读取的图像；如果提前关闭最后一个fd或释放RGA导入句柄，后续异步访问也可能失效。因此零拷贝不仅是地址共享，还包含缓存同步、完成顺序和对象生命周期管理。

理想的图像处理路径可以是：

```text
V4L2/ISP采集到DMA-BUF
→ RGA导入DMA-BUF并完成缩放或颜色转换
→ NPU导入处理后的DMA-BUF进行推理
→ MPP导入DMA-BUF进行编码
```

实际工程中，格式、stride、地址位数、安全域或运行库导入能力不兼容时，仍可能发生格式转换或额外复制。因此“传递了fd”不等于整条链路一定零拷贝，需要逐段确认下游是否真正导入了原缓冲区。

## 3 DMA、IOMMU与DMA-BUF的底层关系和常见问题

前两部分说明了具体流程，本部分只解释这些流程中最容易产生误解的底层关系，不再另起一套内存使用过程。

### 3.1 dma_map_sgtable为什么没有启动DMA硬件

`dma_map_sgtable()`属于Linux DMA Mapping子系统。函数名中的`dma_`表示它服务于接下来的DMA访问，并不表示该函数由DMA硬件执行。

调用该函数时发生的是：

```text
CPU执行设备驱动
→ CPU进入DMA Mapping层
→ 根据目标设备准备DMA地址和缓存状态
→ 有IOMMU时，CPU继续执行IOMMU建表代码
→ 返回dma_addr_t或已映射SG表
```

此时设备可能仍处于空闲状态。只有驱动随后把DMA地址写入硬件并提交任务，设备才真正开始读写DDR。

通用DMA API的意义在于屏蔽不同平台的地址转换方式：

- **设备启用IOMMU：**DMA API进入IOMMU路径，建立IOVA到物理页的映射。
- **设备未启用IOMMU：**DMA API可能返回经过平台总线地址转换后的地址；这个地址不能一概等同于CPU物理地址。
- **设备寻址范围不足：**DMA层可能使用SWIOTLB反弹缓冲区，把数据复制到设备能够访问的区域。因此即使接口仍然叫DMA映射，底层也可能出现额外复制。

缓存维护同样是DMA Mapping接口的一部分。对非一致性设备，DMA层可能在CPU和设备切换缓冲区所有权时执行必要的Cache clean或invalidate，但具体行为取决于架构、映射类型和驱动调用方式，不能简单理解为“没有IOMMU就一定flush后直接返回物理地址”。

### 3.2 DMA能力与IOMMU拓扑由硬件和驱动共同决定

DMA负责实际发起或协助数据传输，IOMMU负责翻译设备发出的地址，两者不是同一个硬件。

```text
DMA或设备总线主控：负责发出读写请求，真正搬运数据
IOMMU：负责把请求中的IOVA翻译成物理地址并检查访问权限
DDR控制器：根据最终物理地址完成内存读写
```

不能把系统概括成“每个设备一定有一个独立DMA，而整个芯片只有一个IOMMU”：

- RGA、GPU、VOP等高吞吐模块通常能够主动访问内存，可以并行执行各自任务；
- 一些普通外设没有独立的数据搬运引擎，而是使用系统通用DMAC；
- 并非所有DMA请求都一定经过IOMMU，是否经过取决于SoC总线连接、Device Tree和驱动配置；
- SoC内部也可能存在多个IOMMU实例。RK3588的Device Tree中可以看到RGA、VOP、VPU、VDEC和VICAP等模块对应的多个IOMMU节点。

IOMMU通常具有地址转换缓存TLB，以减少反复查询页表的开销，但具体缓存层级、命中率和延迟属于芯片微架构，不能在没有芯片手册或性能数据的情况下固定写成“每个设备都有Micro-TLB、99%命中或一个周期完成”。

因此，判断某个设备是否使用DMA和IOMMU，应沿着下面的关系确认：

```text
硬件模块是否能够发起DMA或连接到通用DMAC
→ Device Tree是否描述了DMA/IOMMU连接
→ 驱动是否按该硬件方式配置DMA mask和IOMMU
→ 运行时DMA API最终选择了哪条映射路径
```

### 3.3 IOMMU fault和DMA-BUF导入失败的分阶段排查

RGA提示IOMMU错误时，并不一定是IOMMU页表代码本身出错。应把问题对应回前两部分的实际阶段：

**缓冲区分配阶段失败：**可能是普通内存不足、CMA不足，或者驱动要求的大块连续内存无法整理出来。此时通常还没有进行IOMMU映射。

**DMA-BUF导出或fd传递失败：**可能是驱动不支持导出、传入的fd并非DMA-BUF、fd已经被提前关闭，或者GEM handle、V4L2 buffer index使用错误。

**attachment和DMA映射失败：**可能是目标设备DMA mask不满足要求、IOMMU地址空间不足、安全域不兼容，或者导出者返回的页面组织无法被导入设备接受。

**硬件启动后产生IOMMU fault：**说明设备已经使用某个IOVA发起访问，但访问没有有效映射或超出了已映射范围。常见原因是地址、offset、stride、格式或图像高度计算错误，也可能是缓冲区已经解除映射或提前释放。

**任务完成但CPU读到旧数据：**应检查设备是否真正完成、fence是否等待，以及CPU与设备之间是否进行了必要的缓存同步。

常用观察命令如下：

```bash
# 查看系统提供了哪些DMA-HEAP分配入口。
ls -l /dev/dma_heap/

# 查看当前进程中的fd分别引用什么对象，确认fd是否仍然存在。
ls -l /proc/<PID>/fd/

# 查看当前进程通过mmap建立的CPU虚拟地址区域。
cat /proc/<PID>/maps

# 查找RGA、IOMMU和DMA-BUF相关内核日志。
dmesg | grep -i -E "rga|iommu|dma.buf|dma_buf"
```

相关接口与约定可参考Linux内核的[DMA映射指南](https://docs.kernel.org/core-api/dma-api-howto.html)、[DMA API文档](https://docs.kernel.org/core-api/dma-api.html)、[DMA-BUF框架文档](https://docs.kernel.org/driver-api/dma-buf.html)、[V4L2缓冲区导出文档](https://docs.kernel.org/userspace-api/media/v4l/vidioc-expbuf.html)和[DRM内存管理文档](https://docs.kernel.org/gpu/drm-mm.html)。
