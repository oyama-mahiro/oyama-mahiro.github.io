---
title: '[嵌入式AI-C++工程] Linux进程、线程、文件描述符和动态库'
published: 2026-09-24T08:08:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍Linux进程、线程、文件描述符和动态库的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-9 Linux进程、线程、文件描述符和动态库

在嵌入式 AI 工程中，一段 C++ 推理代码从来不是孤立运行的。摄像头推流进来是文件描述符（V4L2 设备），多核图像处理涉及线程同步，跨进程传递大图需要共享内存，模型动态加载依赖 `.so` 动态库，开机后自动拉起程序需要 systemd 服务。

本篇建立 Linux 运行时的系统认知底座，彻底讲清六件事：
1. **启动链全貌**：RK3588 从芯片上电到拉起用户视觉程序经历了哪些阶段；
2. **执行边界**：进程隔离、线程共享、用户态与内核态的切换本质；
3. **IPC 通信选型**：不同场景（大图传输 vs 事件唤醒 vs 跨进程命令）如何精准选择通信手段；
4. **虚拟内存与 mmap**：零拷贝大图传输与模型权重直接映射的底层逻辑；
5. **统一 I/O 与 epoll**：一切皆文件描述符，多路复用怎样避免无谓轮询；
6. **动态库与 ELF 分析**：编译期链接、运行时加载、符号导出及常见部署翻车排查。

---

## 1 本阶段知识范围与学习目标

### 1.1 Linux系统资源与嵌入式程序的关系

一个典型的嵌入式 AI 视觉程序（如 RK3588 边缘计算盒子），其底层直接与操作系统资源强绑定：

- **硬件输入**：摄像头节点（`/dev/video0`）、串口（`/dev/ttyS2`）、NPU 加速核心（`/dev/rknpu`）均作为特殊设备暴露；
- **配置与模型**：权重文件、JSON 配置、推理日志统一抽象为文件描述符进行读写与内存映射；
- **计算并发**：预处理、NPU 推理、后处理检测框解析通过多线程共享内存加速流动；
- **多进程架构**：视频拉流守护进程与主推理服务之间，通过共享内存传输大图像帧，通过管道或 Socket 传递控制指令；
- **依赖打包**：OpenCV、RKNN 运行时、FFmpeg 必须在正确的运行时搜索路径下被动态链接加载；
- **系统自启**：开机后设备节点未就绪、网络未连通时，systemd 必须负责按依赖拓扑完成服务拉起与崩溃自愈。

掌握系统层原理的核心目标，是建立排查四类典型生产事故的证据直觉：**资源由谁分配、归谁持有、何时就绪、失败时提取什么日志**。

### 1.2 本阶段需要掌握的深度

完成本节后，应当能够：

1. 还原 Ubuntu 22.04 在 ARM 平台从上电到用户进程运行的完整阶段；
2. 熟练配置 systemd 服务、udev 设备别名、网络持久化与开机自动挂载；
3. 准确区分进程虚拟地址隔离、线程栈独占与共享堆空间；
4. 针对不同数据量（几十字节指令 vs 数十兆图像），给出最优跨进程通信方案并给出代码落地；
5. 熟练运用 `/proc`、`systemctl`、`journalctl`、`ldd`、`readelf`、`nm` 定位运行时故障；
6. 理解 `epoll` 红黑树与就绪链表的内部机理，分清 LT 与 ET 的代码读写差异；
7. 明确区分编译链接报错、动态链接器找不到 `.so`、以及运行时 `dlsym` 符号解析失败的根本区别。

---

## 2 RK3588上的Ubuntu 22.04从上电到启动用户程序

### 2.1 RK3588从上电到进入Linux内核

RK3588 芯片上电瞬间，CPU 处于未初始化状态，外部 DDR 内存控制器完全不可用，更谈不上运行 Linux。整个启动链路是一个环环相扣的“滚雪球”过程：

```text
芯片上电
  ↓
BootROM 固化代码运行（SRAM 运行，检测启动介质）
  ↓
执行 DDR 初始化代码（内存训练，让几十 GB 外部内存可用）
  ↓
加载 SPL 或厂商 MiniLoader
  ↓
加载 ARM 安全固件（BL31 建立安全隔离）
  ↓
启动完整 U-Boot（具备驱动外设、读取文件系统能力）
  ↓
加载 Linux 内核映像（Image）、设备树（DTB）、initramfs
  ↓
CPU 控制权正式转交 Linux 内核入口
```

1. **BootROM 阶段**：RK3588 内部固化的只读代码最先启动。它仅能使用芯片内部几十 KB 的极小静态内存（SRAM），扫描 eMMC/SD 卡/SPI Flash 等介质的特定偏移，将最基础的加载引导程序调入内部 SRAM。
2. **DDR 初始化**：由于外部 DDR 内存引脚多、信号频率极高，必须先执行 DDR 初始化程序（Vendor MiniLoader 或 U-Boot TPL/SPL）进行时序校准与内存训练。此阶段完成后，庞大的外部物理内存才正式开放访问。
3. **安全固件接管（BL31）**：系统进入 ARM Trusted Firmware（ATF）中的 `BL31`，初始化底层 TrustZone 安全监视器，奠定底层硬件安全环境，随后降权跳转到普通引导程序。
4. **U-Boot 阶段**：完整的 U-Boot 加载并驱动存储设备，从引导分区读出 Linux 内核镜像（`Image`）、开发板硬件描述拓扑（`DTB`）、启动参数（`bootargs`）以及临时根文件系统（`initramfs`），随后直接执行长跳转，将 CPU 执行流交给 Linux 内核。

### 2.2 Linux内核的初始化过程

Linux 内核接管 CPU 后，开始建立操作系统核心机制：

```text
进入 Linux 内核入口
  ↓
建立早期虚存页表（开启 MMU 内存管理单元）
  ↓
解析设备树 DTB（识别板载硬件设备，匹配驱动节点）
  ↓
进入 start_kernel()（初始化中断、时钟、调度器、VFS）
  ↓
衍生关键内核任务：
  - PID 0：空闲任务（idle）
  - PID 1：kernel_init（向用户空间过渡的起点）
  - PID 2：kthreadd（负责管理后续所有内核后台线程）
```

- **设备树（Device Tree）的核心意义**：嵌入式 ARM 架构不像 x86 那样具备即插即用的 PCI 总线枚举机制。内核依靠 DTB 文本编译出的二进制树，才能明确板载外设有几个 I2C、摄像头 CSI 通道挂在哪、NPU 中断号是多少。设备树是硬件拓扑的描述清单，内核以此匹配对应的内核驱动。
- **内核驱动与用户驱动模块**：直接编译进内核镜像的基础驱动随内核启动；而以 `.ko` 形式动态编入的驱动模块，则等待根文件系统挂载后由用户层程序按需加载。

### 2.3 initramfs与Ubuntu根文件系统的挂载过程

内核虽然初始化完毕，但此时真正的 Ubuntu 系统文件（包含 `/bin`、`/lib`、`/usr`）仍然静躺在 eMMC、SD 卡或 NVMe 固态硬盘的物理分区中。

由于读取这些存储设备往往需要复杂的存储协议栈或特定驱动，Linux 采用 **initramfs（内存临时根文件系统）** 作为跳板：

```text
内核在内存中展开 initramfs 镜像
  ↓
以 initramfs 为临时根目录，执行其内部的 /init（以 PID 1 运行）
  ↓
/init 按需加载底层存储控制器驱动与 ext4/btrfs 文件系统驱动
  ↓
根据内核启动参数 root=UUID=... 定位真实的 Ubuntu 物理分区
  ↓
将物理分区挂载到临时挂载点
  ↓
调用 switch_root（彻底切根，释放内存中的临时 initramfs）
  ↓
通过 exec 覆盖替换进程映像，无缝执行真正 Ubuntu 系统的 /sbin/init
```

> **系统工程要点**：
> 从 initramfs 中的 `/init` 切换到真实 Ubuntu 中的 `/sbin/init`（通常软链接到 systemd），是通过 `exec` 系统调用就地覆盖的。因此，**PID 1 的进程编号始终传承保留**。

### 2.4 systemd启动系统服务的过程

从 `/sbin/init` 接管系统开始，Linux 正式进入纯粹的**用户空间管理阶段**。在 Ubuntu 22.04 中，PID 1 由 systemd 牢牢占据，负责整个系统的拓扑化编排：

```text
systemd (PID 1) 启动
  ↓
读取系统配置并运行配置生成器（解析 fstab、Netplan 等）
  ↓
根据 target（目标状态）构建由单元（Unit）组成的有向无环依赖图（DAG）
  ↓
无依赖关系的单元并发启动（极速启动的关键）
  ↓
拉起底层基础设施（日志 journald、设备守护 udevd）
  ↓
自动挂载外部存储、配置网卡 IP
  ↓
按依赖拓扑启动应用级服务、进入 multi-user.target，最终拉起业务程序
```

systemd 管理的最核心对象是**单元（Unit）**：
- `.service`：长期运行的应用后台守护进程；
- `.mount`：文件系统挂载任务；
- `.device`：硬件设备在 systemd 视角的抽象映像；
- `.target`：一组服务的聚合状态终点（如 `multi-user.target` 代表非图形界面的完整多用户运行状态）。

### 2.5 Ubuntu启动过程中常见配置及其负责组件

生产环境中配置错误往往会导致“开机进不了系统”或“服务启动失败”。必须理清不同配置文件到底是**谁在什么时候读取的**：

#### 2.5.1 U-Boot阶段的内核启动参数
- **配置文件**：`/boot/extlinux/extlinux.conf` 或 U-Boot 环境变量。
- **作用者**：U-Boot 在跳向内核之前读取。
- **核心语法**：
  ```text
  APPEND root=PARTUUID=e9b06821-02 rootwait rw console=ttyS2,1500000
  ```
  指定真正的根文件系统分区标识（优先用 `UUID` 或 `PARTUUID`，避免写死的盘符 `/dev/mmcblk0p2` 因外设插拔变动而漂移）。

#### 2.5.2 早期系统生成器阶段（Generators）
- **作用者**：systemd 刚跑起来的最初几毫秒，调用短命生成器将异构配置自动转译为 systemd 原生 unit。
- **典型转译**：
  - `systemd-fstab-generator`：将传统的 `/etc/fstab` 翻译为内存中的 `.mount` 单元；
  - Netplan Generator：将 `/etc/netplan/*.yaml` 翻译为 `systemd-networkd` 或 NetworkManager 底层配置文件。

#### 2.5.3 基础系统治理配置清单

| 配置项 | 配置文件位置 | 负责处理的服务 | 生效阶段与工程作用 |
|---|---|---|---|
| **内核模块自启** | `/etc/modules-load.d/*.conf` | `systemd-modules-load` | 开机主动注入如 `v4l2loopback`（虚拟摄像头）驱动 |
| **模块传参** | `/etc/modprobe.d/*.conf` | 内核模块加载工具 | 配置驱动初始化参数（如强制摄像头设备编号 `video_nr=10`） |
| **内核运行时参数** | `/etc/sysctl.d/*.conf` | `systemd-sysctl` | 调节 TCP/网络接收缓冲上限（如高吞吐推流防丢包） |
| **外设名称与权限** | `/etc/udev/rules.d/*.rules` | `systemd-udevd` | 匹配 USB 供应商 ID，给摄像头固定符号链接 `/dev/vision_cam` |

#### 2.5.4 文件系统挂载配置（`/etc/fstab`）
在系统启动后负责将外置数据盘（如保存模型的 SSD）自动挂载到指定目录：
```fstab
UUID=a1b2c3d4-e5f6-7890-1234-56789abcdef0  /data  ext4  defaults,nofail  0  2
```
*提示：嵌入式外挂存储务必添加 `nofail` 标记，防止因外置硬盘未插导致开机卡死挂起。*

#### 2.5.5 网络与静态 IP 配置（Netplan）
在 `/etc/netplan/01-netcfg.yaml` 中配置工控机静态 IP：
```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    eth0:
      dhcp4: false
      addresses:
        - 192.168.1.100/24
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [192.168.1.1, 8.8.8.8]
```

#### 2.5.6 用户服务自启动工程模板（`.service`）
生产级视觉服务必须配置为受管服务。新建 `/etc/systemd/system/vision-app.service`：
```ini
[Unit]
Description=RK3588 AI Vision Pipeline
# 严格保证网络在线且模型存储盘已完成挂载后才启动
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/data/models

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/vision
ExecStart=/opt/vision/bin/vision_app
EnvironmentFile=-/etc/vision-app.env
# 核心业务崩溃自愈策略：异常退出后延迟 3 秒重新拉起
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```
加载使能：
```bash
sudo systemctl daemon-reload
sudo systemctl enable vision-app.service
```

---

## 3 进程、线程、用户空间与内核空间

### 3.1 进程和线程的基本区别

- **进程（Process）**：**系统资源分配与安全隔离的基本单位**。每个进程拥有完全独立的虚拟地址空间。进程 A 内部指针 `0x7fff0000` 存的值，与进程 B 内部完全相同数值的指针，指向的物理内存毫无瓜葛。进程通过 `fork()` + `execve()` 衍生。
- **线程（Thread）**：**操作系统 CPU 调度的最小执行单位**。多个线程寄生在同一个进程内部，它们天然共享宿主进程的绝大部分资源。

### 3.2 线程共享的资源 vs 线程独占的资源

在多线程 C++ 视觉并发编程中，必须清楚哪些共享、哪些独占：

```text
同一进程内部所有线程共享：
├── 代码段（.text）
├── 全局变量与静态变量（.data, .bss）
├── 动态堆空间（malloc / new 分配的图像内存）
├── 文件描述符表（一个线程 close(fd)，全局失效）
└── 内存映射区（mmap 映射的模型权重）

每个线程独立私有：
├── 程序计数器 PC 与寄存器集合（当前执行到哪行代码）
├── 线程用户栈（局部变量分配区，默认通常 8MB）
├── 线程局部存储（thread_local 变量）
├── errno 错误状态码
└── 信号屏蔽掩码
```

> **内存越界与悬空指针警告**：
> 局部变量虽然分配在当前线程的私有栈上，但由于进程内部地址是通透的，只要将其地址传给其他线程，其他线程依然能够读取修改。然而，一旦原线程函数返回，栈帧被销毁，该指针立刻退化为毁灭性的悬空指针（Dangling Pointer）。

### 3.3 用户空间与内核空间：地址与特权隔离

现代 CPU 配合 Linux 实行严格的特权分级（x86 的 Ring0/Ring3，ARM 的 EL1/EL0）：
- **用户空间（User Space / 用户态）**：普通应用程序运行于此。无法执行特权指令，无法直接访问物理外设寄存器。如果程序崩溃（段错误），只会终止自身，操作系统内核岿然不动。
- **内核空间（Kernel Space / 内核态）**：操作系统核心与驱动代码运行于此，拥有全量硬件特权。

### 3.4 系统调用（System Call）的工作原理

用户态代码绝不能直接访问底层硬件。要读写摄像头或网络数据，必须穿透系统调用门：

```text
用户程序调用 glibc 的 read()
  ↓
将系统调用号（SYS_read）及参数装填进 CPU 寄存器
  ↓
触发软件中断或专用系统调用指令（x86 的 syscall，ARM 的 svc）
  ↓
CPU 硬件切换为特权内核态，跳转到内核预设的系统调用分发入口
  ↓
内核安全检查传入指针与长度，深入驱动层执行数据搬运
  ↓
内核将执行结果放入返回值寄存器（若出错放入负错误码）
  ↓
CPU 恢复用户态上下文，返回用户代码；glibc 解析负返回值，设置全局 errno 并返回 -1
```

> **系统调用与上下文切换的误区**：
> 一次系统调用（如快速读取时钟）只是当前 CPU 核心从用户态跃迁到内核态执行一段逻辑，**并不必然触发进程上下文调度切换**。只有当本次系统调用遭遇阻塞（如从没有数据的 Socket 读取，线程主动挂起出让 CPU）时，才会引发真正的进程调度。

### 3.5 借助 /proc 文件系统透视运行时状态

`/proc` 是 Linux 内核以文件系统形式呈现给用户态的动态内省控制台：

```bash
cat /proc/<PID>/status       # 观察进程状态、线程数（Threads）、内存峰值（VmPeak）
cat /proc/<PID>/maps         # 观察进程完整的虚拟地址空间段布局
ls -l /proc/<PID>/fd         # 列出进程当前打开的所有文件描述符及真实指向
cat /proc/<PID>/limits       # 检查进程最大允许打开文件数（Max open files）
cat /proc/<PID>/cmdline      # 获取进程启动时的完整命令行参数（以 \0 分隔）
```

---

## 4 进程通信与线程通信方式

### 4.1 通信技术选型决策图

在分布式视觉服务或多进程工控架构中，选型必须依据**数据量级**与**交互语义**：

```text
通信场景决策：
│
├── 同一进程内部多线程协作 ─────────────────> 互斥锁 + 条件变量 / 阻塞队列
│
├── 仅传递退出、热重载等简易信号 ─────────────> Linux 信号（Signals）
│
├── 单步事件通知 / 唤醒 epoll 事件循环 ──────> eventfd（无开销 8 字节计数器）
│
├── 传递有边界的简易控制指令、参数报文 ──────> POSIX 消息队列（mq_open）
│
├── 父子进程间传递单向日志、诊断流 ──────────> 匿名管道（pipe）
│
├── 独立脚本向本地服务单向投递字符指令 ──────> 命名管道（FIFO）
│
├── 本地服务对外提供多客户端双向控制服务 ────> Unix Domain Socket
│
└── 跨进程高速传递超大图像帧（RGB / YUV） ───> POSIX 共享内存（shm_open + mmap）
```

### 4.2 匿名管道（pipe）：父子单向字节流

匿名管道是内核驻留的无名字单向环形缓冲区。创建时生成一对文件描述符：`fds[0]` 是读端，`fds[1]` 是写端。常用于 `fork()` 衍生的父子进程单向任务推送。

```cpp
// pipe_demo.cpp：父进程通过匿名管道向子进程发送任务指令
#include <cerrno>
#include <cstdlib>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>

int main() {
    int pipe_fds[2]{};
    if (pipe(pipe_fds) == -1) {
        std::cerr << "pipe failed\n";
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        close(pipe_fds[0]);
        close(pipe_fds[1]);
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        // 子进程只读：必须先关闭自己继承来的写端描述符
        close(pipe_fds[1]);

        char buffer[64]{};
        while (true) {
            const ssize_t n = read(pipe_fds[0], buffer, sizeof(buffer));
            if (n > 0) {
                std::cout.write(buffer, n);
                continue;
            }
            if (n == 0) {
                // 当所有写端都被 close 之后，read 才会返回 0（读到 EOF）
                break;
            }
            if (errno == EINTR) continue;
            close(pipe_fds[0]);
            _exit(EXIT_FAILURE);
        }

        close(pipe_fds[0]);
        _exit(EXIT_SUCCESS);
    }

    // 父进程只写：关闭读端
    close(pipe_fds[0]);

    const char message[] = "process image frame #1\n";
    write(pipe_fds[1], message, sizeof(message) - 1);

    // 关键点：关闭父进程最后的写端，子进程才能从 read 退出并感知 EOF
    close(pipe_fds[1]);

    int status = 0;
    waitpid(child_pid, &status, 0);
    return (WIFEXITED(status) && WEXITSTATUS(status) == EXIT_SUCCESS)
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

### 4.3 命名管道（FIFO）：独立进程间的单向路径入口

与匿名管道相比，FIFO 在文件系统上暴露真实路径节点（由 `mkfifo` 创建），允许两个完全无关的独立程序对接。

```cpp
// fifo_reader.cpp：独立接收端
#include <cerrno>
#include <cstdlib>
#include <fcntl.h>
#include <iostream>
#include <sys/stat.h>
#include <unistd.h>

int main() {
    constexpr const char* kPath = "/tmp/vision_demo_fifo";
    if (mkfifo(kPath, 0600) == -1 && errno != EEXIST) {
        std::cerr << "mkfifo failed\n";
        return EXIT_FAILURE;
    }

    // 默认阻塞打开：open(O_RDONLY) 会在此挂起休眠，直到另一进程以 O_WRONLY 打开该路径
    const int fd = open(kPath, O_RDONLY);
    if (fd == -1) return EXIT_FAILURE;

    char buffer[64]{};
    const ssize_t n = read(fd, buffer, sizeof(buffer));
    if (n > 0) {
        std::cout.write(buffer, n);
    }

    close(fd);
    unlink(kPath); // 用完清理节点
    return EXIT_SUCCESS;
}
```

```cpp
// fifo_writer.cpp：独立发送端
#include <cstdlib>
#include <fcntl.h>
#include <unistd.h>

int main() {
    const int fd = open("/tmp/vision_demo_fifo", O_WRONLY);
    if (fd == -1) return EXIT_FAILURE;

    const char msg[] = "reload_model\n";
    write(fd, msg, sizeof(msg) - 1);
    close(fd);
    return EXIT_SUCCESS;
}
```

### 4.4 Unix Domain Socket（UDS）：本地全双工服务首选

如果需要跨进程进行请求-响应（Request-Response）双向交互，UDS 是性能最高、语义最健全的方式。

下面通过 `socketpair()` 演示在一对预连接的本地 Socket 上进行全双工通信：

```cpp
// unix_socket_demo.cpp：双向本地通信
#include <cstdlib>
#include <iostream>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

int main() {
    int sockets[2]{};
    // SOCK_SEQPACKET 提供像 TCP 一样的可靠双向通道，同时保留单次 send 的数据报边界
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) == -1) {
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) return EXIT_FAILURE;

    if (child_pid == 0) {
        close(sockets[0]); // 子进程持有端 sockets[1]

        char request[64]{};
        const ssize_t n = recv(sockets[1], request, sizeof(request), 0);
        if (n > 0) {
            const char reply[] = "ACK: model reloaded";
            send(sockets[1], reply, sizeof(reply) - 1, 0);
        }
        close(sockets[1]);
        _exit(EXIT_SUCCESS);
    }

    close(sockets[1]); // 父进程持有端 sockets[0]

    const char req[] = "CMD: reload";
    send(sockets[0], req, sizeof(req) - 1, 0);

    char reply[64]{};
    const ssize_t n = recv(sockets[0], reply, sizeof(reply), 0);
    if (n > 0) {
        std::cout.write(reply, n);
        std::cout << '\n';
    }

    close(sockets[0]);
    waitpid(child_pid, nullptr, 0);
    return EXIT_SUCCESS;
}
```

### 4.5 POSIX 共享内存：大图像无拷贝传输基石

把千兆网口或摄像头输入的 4K YUV 原始数据传给另一个进程，如果走管道或 Socket，会在内核空间发生多次完全不必要的内存 `memcpy`。

**POSIX 共享内存（`shm_open` + `mmap`）** 让内核将同一段物理内存同时映射入两个进程的虚拟地址空间，读写大图实现**零拷贝（Zero-Copy）**：

```cpp
// shared_memory_demo.cpp：零拷贝多进程共享结构
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <iostream>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

struct SharedFrameHeader {
    uint32_t frame_id;
    uint32_t width;
    uint32_t height;
    char payload[64]; // 真实场景中此处紧跟大尺寸图像像素缓冲区
};

int main() {
    constexpr const char* kShmName = "/vision_frame_shm_demo";

    // 1. 创建共享内存文件描述符（位于 tmpfs 虚拟内存文件系统）
    const int owner_fd = shm_open(kShmName, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
    if (owner_fd == -1) return EXIT_FAILURE;

    // 2. 刚刚创建的共享内存大小为 0，必须显式截断设定真实物理体积
    if (ftruncate(owner_fd, sizeof(SharedFrameHeader)) == -1) {
        shm_unlink(kShmName);
        return EXIT_FAILURE;
    }

    // 3. 将其映射至本进程的虚拟地址空间
    void* addr = mmap(nullptr, sizeof(SharedFrameHeader), PROT_READ | PROT_WRITE,
                      MAP_SHARED, owner_fd, 0);
    if (addr == MAP_FAILED) {
        shm_unlink(kShmName);
        return EXIT_FAILURE;
    }

    auto* frame = static_cast<SharedFrameHeader*>(addr);
    frame->frame_id = 1001;
    frame->width = 1920;
    frame->height = 1080;
    std::snprintf(frame->payload, sizeof(frame->payload), "%s", "RAW_IMAGE_DATA_BYTES");

    const pid_t child_pid = fork();
    if (child_pid == 0) {
        // 子进程按名字重新打开该共享内存并映射读取
        const int r_fd = shm_open(kShmName, O_RDONLY | O_CLOEXEC, 0);
        void* r_addr = mmap(nullptr, sizeof(SharedFrameHeader), PROT_READ, MAP_SHARED, r_fd, 0);

        const auto* r_frame = static_cast<const SharedFrameHeader*>(r_addr);
        std::cout << "Child read frame: " << r_frame->frame_id
                  << " (" << r_frame->width << "x" << r_frame->height << ") "
                  << r_frame->payload << '\n';

        munmap(r_addr, sizeof(SharedFrameHeader));
        close(r_fd);
        _exit(EXIT_SUCCESS);
    }

    waitpid(child_pid, nullptr, 0);

    // 4. 用完彻底释放映射，并从系统中 unlink 删除名字
    munmap(addr, sizeof(SharedFrameHeader));
    close(owner_fd);
    shm_unlink(kShmName);
    return EXIT_SUCCESS;
}
```

> **进程同步底线**：
> 共享内存仅提供“数据通路”，其自身**绝不附带任何锁与同步机制**！在多进程并发读写时，必须外加基于共享内存的命名信号量（`sem_open`）或设置了 `PTHREAD_PROCESS_SHARED` 属性的互斥锁做互斥保驾。

### 4.6 eventfd：轻量级事件计数通知

`eventfd()` 在内核中仅占用一个 8 字节（`uint64_t`）计数器。写入一个整数代表累加事件次数；读取该整数代表消费该事件。它具有原生文件描述符身份，能够直接挂载到 `epoll` 监听列表中，是**跨线程/跨进程快速唤醒事件循环的最佳利器**：

```cpp
// eventfd_demo.cpp：单步事件计数通知
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <sys/eventfd.h>
#include <sys/wait.h>
#include <unistd.h>

int main() {
    const int efd = eventfd(0, EFD_CLOEXEC);
    if (efd == -1) return EXIT_FAILURE;

    const pid_t child_pid = fork();
    if (child_pid == 0) {
        uint64_t val = 0;
        // read 会一直阻塞，直到有其他进程向 efd 写入计数（计数器非 0）
        read(efd, &val, sizeof(val));
        std::cout << "Child awakened! Event count = " << val << '\n';
        close(efd);
        _exit(EXIT_SUCCESS);
    }

    sleep(1);
    const uint64_t increment = 5; // 写入 5，一次性唤醒并传递计数
    write(efd, &increment, sizeof(increment));

    waitpid(child_pid, nullptr, 0);
    close(efd);
    return EXIT_SUCCESS;
}
```

---

## 5 虚拟内存、页与mmap内存映射

### 5.1 虚拟内存与物理内存的映射机制

Linux 应用程序中看到的一切内存地址，无一例外全是**虚拟地址**。CPU 内部的硬件单元 MMU（内存管理单元）通过多级页表，在硬件层面将虚拟地址即时换算为实际的物理内存地址。

- **逻辑连续不等于物理连续**：应用程序申请了一块连续的 100MB 堆空间（虚拟地址连续），这 100MB 在底层的物理内存中极大概率是被分散打碎在各个角落的离散物理页。
- **DMA 硬件的硬性制约**：摄像头 ISP 或 NPU 硬件底层做高速 DMA 数据搬运时，往往要求**物理地址绝对连续**。这就是为什么在嵌入式 AI 中，直接拿 `malloc` 出来的内存接摄像头采集经常报错，必须使用底层驱动提供的连续内存分配器（如 DRM/DMA-BUF）。

### 5.2 内存页与缺页异常（Page Fault）

内存管理的最小物理映射颗粒度是**页（Page）**，标准系统通常为 4KB（通过 `getconf PAGE_SIZE` 查看）。

当程序调用 `malloc(100MB)` 或 `mmap` 一个超大模型文件时，Linux 采取**惰性分配策略（Lazy Allocation）**：
1. 内核仅仅在进程的虚存管理结构中登记一段虚拟区间，**此时并未真正分配任何物理内存**；
2. 只有当 CPU 真正尝试去读写某一页的瞬间，由于物理映射不存在，CPU 硬件触发**缺页异常（Page Fault）**，执行流瞬间陷入内核；
3. 内核在缺页处理程序中现从空闲物理页池中抠出一个 4KB 物理页，写入页表，再让程序恢复执行。

### 5.3 mmap 映射大模型文件的工程妙用

加载一个几百兆的 RKNN 或 ONNX 模型文件时，传统方式是调用 `read()` 将文件从内核缓冲区反复搬运到用户堆内存。
更高效的做法是直接调用 `mmap`：

```cpp
int fd = open("model.rknn", O_RDONLY | O_CLOEXEC);
struct stat sb;
fstat(fd, &sb);

// 将模型文件直接映射进进程地址空间
void* model_ptr = mmap(nullptr, sb.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
// 映射建立后，可以直接关闭文件描述符，映射依然有效保持
close(fd);

// 此时可以直接把 model_ptr 当成内存指针传给推理引擎底层加载接口！
rknn_init(&ctx, model_ptr, sb.st_size, 0, nullptr);

// 推理引擎使用完毕后彻底解除映射
munmap(model_ptr, sb.st_size);
```

**优势**：免去全盘深拷贝，模型文件由操作系统的页缓存（Page Cache）统一接管调配。系统如果内存充裕，模型权重页常驻物理内存；如果系统内存告急，内核可以干净利落地将未修改的只读页回收丢弃，下次访问再无缝重新换入。

---

## 6 文件描述符与Linux统一I/O模型

### 6.1 “一切皆文件”背后的三层内核指针映射

理解文件描述符，切忌将其看作一个空泛的整数。Linux 在内核底层维护着一套三级解耦数据结构：

```text
进程空间（Process Table）
  └── 文件描述符表（fd table）
        [fd = 0] ──> 标准输入
        [fd = 1] ──> 标准输出
        [fd = 3] ───────┐ (多次 dup() 或子进程继承)
        [fd = 4] ───────┴──> 内核打开文件描述（Open File Description）
                               ├── 当前文件偏移量（file offset）
                               ├── 访问状态标志（O_RDONLY / O_NONBLOCK）
                               └── 引用计数（ref count）
                                     ↓
                               内核索引节点（inode / vnode）
                                 ├── 真实文件数据 / 磁盘扇区
                                 └── 真实驱动操作虚表（f_ops: read, write, ioctl）
```

- **数字是私有的，底层是共享的**：通过 `dup()` 或 `fork()` 产生的两个 fd，虽然在不同进程或不同槽位，但它们指向内核同一个打开文件描述，因此**共享文件读写偏移量**；
- **操作接口大一统**：对普通文件调 `read()` 是读磁盘，对 Socket 调 `read()` 是读网络协议栈网卡队列，对串口调 `read()` 是读 UART FIFO 驱动。

### 6.2 避免资源泄漏的核心武器：O_CLOEXEC

当程序调用 `fork()` 时，子进程默认完整继承父进程打开的所有文件描述符。如果子进程随后紧接着调用 `execve()` 启动其他外部程序：
- 那些没有设置 `CLOEXEC`（Close-on-Exec）标记的文件描述符，**将被静默泄露给全新的外部程序继续占用**！
- **恶果**：监听的网络端口无法正常重新绑定（Address already in use）、临时管道写端无法释放导致读取端永久死锁。

**最佳实践**：所有系统调用在创建描述符时，强制原子传入 `CLOEXEC` 标志：
```cpp
int fd = open(path, O_RDONLY | O_CLOEXEC);
int sfd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
int pfd[2]; pipe2(pfd, O_CLOEXEC);
```

---

## 7 epoll的工作原理与使用方法

### 7.1 为什么有了 select/poll 还要 epoll？

当一个本地服务需要同时监听 100 个客户端连接或外设通道时：
- **`select` / `poll` 的低效死穴**：每次调用都必须把包含了 100 个 fd 的长列表完整从用户空间拷贝到内核空间；内核使用 $O(N)$ 轮询遍历每一个 fd 检查是否就绪；调用返回后，用户态又必须写一个巨大的 for 循环挨个排查是谁就绪。连接数越多，性能断崖式下跌。
- **`epoll` 的颠覆性突破**：
  1. **注册分离**：通过 `epoll_ctl` 增删改监听项，内核常驻红黑树管理，无需反复全量拷贝长列表；
  2. **事件驱动**：当硬件中断或数据包到达时，网卡/驱动的回调函数自动将就绪的 fd 挂入**就绪链表（Ready List）**；
  3. **精准捞取**：`epoll_wait` 只负责把就绪链表里的有效事件直接拷贝给用户，时间复杂度纯粹取决于**就绪活跃的事件个数 $O(k)$**，与监听总数成千上万完全脱钩。

### 7.2 水平触发（LT）与边沿触发（ET）的本质区别

这是所有 I/O 多路复用编程最核心的考核边界：

| 触发机制 | 语义逻辑 | 代码容错度 | 正确处理姿态 |
|---|---|---|---|
| **水平触发 (LT)<br>(默认模式)** | 只要内核缓冲区**还有未读完的数据**，每次调用 `epoll_wait` 就会**持续不断地提醒你**。 | 高。<br>哪怕一次只读 1 个字节，剩下的下次还会报出来。 | 普通逻辑直接处理即可。 |
| **边沿触发 (ET)<br>(EPOLLET)** | 仅当状态发生**由“无数据”跃迁为“有数据”的边沿跳变时，仅仅通知一次**！缓冲区剩余数据不会重复提醒。 | 严苛。<br>一旦漏读，后续将再也收不到事件，形成永久挂起假死。 | **必须配合非阻塞 I/O（`O_NONBLOCK`），收到事件后必须用 while 循环一直 read，直到返回 `EAGAIN` 或 `EWOULDBLOCK` 为止！** |

### 7.3 epoll 核心 API 规范

```cpp
// 1. 创建 epoll 句柄
int epfd = epoll_create1(EPOLL_CLOEXEC);

// 2. 注册关注事件
epoll_event ev{};
ev.events = EPOLLIN; // 关注可读事件（若开启 ET 模式添加 | EPOLLET）
ev.data.fd = target_fd; // 回传透传标记
epoll_ctl(epfd, EPOLL_CTL_ADD, target_fd, &ev);

// 3. 阻塞等待就绪事件
epoll_event events[16];
int num_events = epoll_wait(epfd, events, 16, -1 /* 永久等待 */);
for (int i = 0; i < num_events; ++i) {
    if (events[i].data.fd == target_fd) {
        // 执行非阻塞读写
    }
}
```

---

## 8 Linux动态库的链接、查找与运行时加载

### 8.1 编译链接期与运行加载期的绝对解耦

动态链接的核心思想是：**可执行文件自身不包含第三方库的代码实现，仅在头部留下对该动态库名字（`DT_NEEDED`）的依赖凭据**。

```bash
g++ main.cpp -I/opt/vision/include -L/opt/vision/lib -lvision_engine -o app
```
- `-I`：头文件路径（**仅编译期有效**，告知编译器函数参数和原型）；
- `-L`：库文件搜索路径（**仅链接期有效**，让链接器验证 `libvision_engine.so` 确实存在且符号完整）；
- `-lvision_engine`：指明链接 `libvision_engine.so`。

> **最经典的部署翻车现形记**：
> 很多开发者在自己机器上编译通过了，拷贝到开发板上一跑，直接报错：
> `error while loading shared libraries: libvision_engine.so: cannot open shared object file`
> **根因**：`-L` 的路径在编译成功那一刻就已经作废！编译完成后，Linux 系统的动态链接器（`/lib/ld-linux.so`）必须依赖专门的**运行时搜索规则**重新寻找该库。

### 8.2 动态加载器的运行时搜索黄金阶梯

程序被执行时，系统加载器按以下严密顺序搜索依赖的 `.so`：

1. **RPATH**：编译进可执行文件 ELF 头部的硬编码路径（已被弃用，优先级过高）；
2. **`LD_LIBRARY_PATH` 环境变量**：开发调试常用；
3. **RUNPATH**：现代 CMake 推荐方案，写入 ELF 头部的指定目录，但允许被环境变量覆盖；
4. **`/etc/ld.so.cache` 缓存清单**：通过 `/etc/ld.so.conf.d/` 写入并执行 `sudo ldconfig` 刷新的系统索引；
5. **系统默认目录**：`/lib`、`/usr/lib`，以及 ARM 架构的 `/usr/lib/aarch64-linux-gnu`。

### 8.3 CMake 优雅解决相对路径依赖：`$ORIGIN`

在产品交付部署时，不可能要求客户在机器上修改 `LD_LIBRARY_PATH`，也不能假设安装目录绝对固定。
最佳实践是在 CMake 中使用 **`$ORIGIN`**（代表当前可执行文件所在的真实绝对物理路径）：

```cmake
# 让程序启动时，自动在同级的 ../lib 目录下寻找所有伴生动态库
set_target_properties(app PROPERTIES
    BUILD_RPATH "$ORIGIN/../lib"
    INSTALL_RPATH "$ORIGIN/../lib"
)
```

### 8.4 运行时动态插拔：`dlopen` 与 `dlsym`

如果系统设计了插件式架构（例如根据不同配置动态加载不同检测头算子），可以在运行时手动按路径加载：

```cpp
#include <dlfcn.h>
#include <iostream>

// 定义目标函数签名类型
using InferFunc = int (*)(int);

int main() {
    // 1. 显式打开外部动态库
    void* handle = dlopen("./libdetector.so", RTLD_NOW | RTLD_LOCAL);
    if (!handle) {
        std::cerr << "dlopen error: " << dlerror() << '\n';
        return 1;
    }

    dlerror(); // 清空错误记录
    // 2. 根据纯字符串符号名，检索函数地址
    void* sym = dlsym(handle, "infer_pipeline");
    const char* err = dlerror();
    if (err) {
        std::cerr << "dlsym error: " << err << '\n';
        dlclose(handle);
        return 1;
    }

    auto infer_pipeline = reinterpret_cast<InferFunc>(sym);
    std::cout << "Result = " << infer_pipeline(42) << '\n';

    // 3. 卸载动态库句柄
    dlclose(handle);
    return 0;
}
```

> **C++ 名字修饰（Name Mangling）大坑**：
> C++ 支持函数重载和命名空间，编译器在生成符号表时会将 `infer_pipeline` 篡改为像 `_Z14infer_pipelinei` 这样的复杂符号，导致 `dlsym(handle, "infer_pipeline")` 报错符号找不到！
> **解法**：动态库中供外部动态查找的导出函数，必须用 `extern "C"` 包裹，强行要求编译器保持标准的 C 语言纯净符号名：
> ```cpp
> extern "C" __attribute__((visibility("default"))) int infer_pipeline(int val) { ... }
> ```

---

## 9 ELF文件格式与动态库排查工具

Linux 下的编译产物（`.o`、可执行文件、`.so` 共享库）全部采用统一的 **ELF（Executable and Linkable Format）** 文件格式封装。

### 9.1 ELF 结构的双重视角

- **链接视图（Sections / 节）**：服务于编译器与链接器。
  - `.text`：可执行机器指令；
  - `.rodata`：只读常量（如字符串字面量）；
  - `.data`：已初始化的全局与静态变量；
  - `.bss`：未初始化的全局变量（在文件中不占实际磁盘空间，仅记录大小，启动时由内核批量清零）；
  - `.dynsym` / `.dynstr`：运行时动态链接依赖的符号表与字符串池。
- **执行视图（Segments / 段 / 程序头表）**：服务于内核加载器。将多个属性相同的节合并打包为 `LOAD` 段，一次性设置虚拟内存保护属性（`r-x` 对应代码段，`rw-` 对应数据段）。

### 9.2 工业级二进制排查命令军刀

熟练使用 GNU Binutils 能够独立解决 99% 的底层环境报错：

```bash
# 1. 快速检查二进制文件的目标架构、位数与字节序（排查是否拿 x86 库强行往 ARM 上跑）
file ./vision_app ./libfoo.so
readelf -h ./vision_app | grep -E 'Class|Machine'

# 2. 查看可执行文件依赖哪些动态库（显示系统解析出的具体物理路径）
ldd ./vision_app

# 3. 检查 ELF 头部记录的实际依赖（NEEDED）与内嵌搜索路径（RPATH / RUNPATH）
readelf -d ./vision_app | grep -E 'NEEDED|RPATH|RUNPATH'

# 4. 检查动态库导出了哪些动态符号（验证函数名字是否被正确导出，排查 dlsym 报错）
# -D: 查看动态符号; -C: 还原 C++ 符号修饰(demangle); --defined-only: 仅看已实现的符号
nm -D -C --defined-only ./libfoo.so | grep "foo_run"

# 5. 检查动态库中有哪些符号需要外部提供（标记为 U 的未定义符号）
nm -D --undefined-only ./libfoo.so
```

---

## 10 Linux启动、IPC、epoll与动态库实验

### 10.1 Linux启动链观察实验

在板端实机探查当前系统的服务拓扑状态：

```bash
# 确认 PID 1 及其命令行
ps -p 1 -o pid,comm,args

# 查看当前运行级别目标（正常应为 multi-user.target 或 graphical.target）
systemctl get-default

# 分析开机耗时最长的服务链（开机优化第一步）
systemd-analyze critical-chain

# 检查当前网络由哪家组件接管管理
sudo netplan get
systemctl is-active systemd-networkd NetworkManager

# 观察串口与内核早期报错
journalctl -b -k -p err
```

### 10.2 pipe父子进程通信实验

验证管道跨 `fork()` 传承、阻塞读写，以及写端未关闭导致死锁的故障注入。

```cpp
// pipe_demo.cpp
#include <array>
#include <cerrno>
#include <cstdio>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>

int main() {
    int pipe_fds[2]{};
    if (pipe(pipe_fds) == -1) {
        std::perror("pipe");
        return 1;
    }

    pid_t child_pid = fork();
    if (child_pid == -1) {
        std::perror("fork");
        close(pipe_fds[0]);
        close(pipe_fds[1]);
        return 1;
    }

    if (child_pid == 0) {
        // 子进程只读：关闭读不到的写端
        close(pipe_fds[0]);

        constexpr char kMessage[] = "message from child\n";
        std::size_t sent = 0;
        while (sent < sizeof(kMessage) - 1) {
            ssize_t result = write(pipe_fds[1], kMessage + sent,
                                   sizeof(kMessage) - 1 - sent);
            if (result > 0) {
                sent += static_cast<std::size_t>(result);
            } else if (result == -1 && errno == EINTR) {
                continue;
            } else {
                close(pipe_fds[1]);
                _exit(2);
            }
        }

        // 关闭最后的写端，父进程读取时才能捕获 EOF 正常退出
        close(pipe_fds[1]);
        _exit(0);
    }

    // 父进程只负责读：必须关闭自己的写端！
    // 【故障注入测试】：若注释掉此行，父进程将持有写端不放，下方 read() 永远等不到 EOF，程序陷入永久死锁挂起！
    close(pipe_fds[1]);

    std::array<char, 128> buffer{};
    while (true) {
        ssize_t received = read(pipe_fds[0], buffer.data(), buffer.size());
        if (received > 0) {
            std::cout.write(buffer.data(), received);
        } else if (received == 0) {
            // 所有写端完全关闭，正常遇到 EOF
            break;
        } else if (errno == EINTR) {
            continue;
        } else {
            std::perror("read");
            close(pipe_fds[0]);
            waitpid(child_pid, nullptr, 0);
            return 1;
        }
    }

    close(pipe_fds[0]);
    int child_status = 0;
    waitpid(child_pid, &child_status, 0);
    return 0;
}
```

```bash
g++ -std=c++17 -Wall -Wextra -pedantic pipe_demo.cpp -o pipe_demo
./pipe_demo
```

### 10.3 epoll监控pipe文件描述符实验

实测将非阻塞 `pipe2` 读端挂载到 `epoll` 上，验证事件就绪与排空读取全流程：

```cpp
// epoll_pipe_demo.cpp
#include <array>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <iostream>
#include <sys/epoll.h>
#include <unistd.h>

void close_if_valid(int fd) {
    if (fd >= 0) close(fd);
}

int main() {
    int pipe_fds[2]{-1, -1};
    // 创建具备非阻塞与非继承属性的管道
    if (pipe2(pipe_fds, O_NONBLOCK | O_CLOEXEC) == -1) {
        std::perror("pipe2");
        return 1;
    }

    int epoll_fd = epoll_create1(EPOLL_CLOEXEC);
    if (epoll_fd == -1) {
        std::perror("epoll_create1");
        close_if_valid(pipe_fds[0]);
        close_if_valid(pipe_fds[1]);
        return 1;
    }

    // 注册对读端的关注
    epoll_event interest{};
    interest.events = EPOLLIN;
    interest.data.fd = pipe_fds[0];
    if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, pipe_fds[0], &interest) == -1) {
        std::perror("epoll_ctl");
        close_if_valid(epoll_fd);
        close_if_valid(pipe_fds[0]);
        close_if_valid(pipe_fds[1]);
        return 1;
    }

    // 模拟写入数据
    constexpr char kMessage[] = "pipe is ready\n";
    write(pipe_fds[1], kMessage, sizeof(kMessage) - 1);

    // 阻塞等待就绪通知
    epoll_event ready{};
    int count = epoll_wait(epoll_fd, &ready, 1, 1000);
    if (count == 1 && ready.data.fd == pipe_fds[0]) {
        std::cout << "Ready Event Received! fd = " << ready.data.fd << '\n';

        // 标准消费循环
        std::array<char, 64> buffer{};
        while (true) {
            ssize_t n = read(pipe_fds[0], buffer.data(), buffer.size());
            if (n > 0) {
                std::cout.write(buffer.data(), n);
            } else if (n == -1 && errno == EINTR) {
                continue;
            } else if (n == -1 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
                std::cout << "Buffer fully drained (EAGAIN).\n";
                break;
            } else {
                break;
            }
        }
    }

    close_if_valid(epoll_fd);
    close_if_valid(pipe_fds[0]);
    close_if_valid(pipe_fds[1]);
    return 0;
}
```

```bash
g++ -std=c++17 -Wall -Wextra -pedantic epoll_pipe_demo.cpp -o epoll_pipe_demo
./epoll_pipe_demo
```

### 10.4 动态库构建、检查与加载失败实验

构建工程验证动态链接依赖关系，并模拟缺少 `.so` 时的故障复现与 `$ORIGIN` 修复：

#### 源码与构建文件准备

```cpp
// frame_stats.hpp
#pragma once
#include <cstddef>
#include <cstdint>

extern "C" double frame_mean(const std::uint8_t* values, std::size_t count);
```

```cpp
// frame_stats.cpp
#include "frame_stats.hpp"

extern "C" double frame_mean(const std::uint8_t* values, std::size_t count) {
    if (!values || count == 0) return 0.0;
    std::uint64_t sum = 0;
    for (std::size_t i = 0; i < count; ++i) {
        sum += values[i];
    }
    return static_cast<double>(sum) / static_cast<double>(count);
}
```

```cpp
// main.cpp
#include "frame_stats.hpp"
#include <array>
#include <iostream>

int main() {
    const std::array<std::uint8_t, 4> vals{10, 20, 30, 40};
    std::cout << "mean=" << frame_mean(vals.data(), vals.size()) << '\n';
    return 0;
}
```

```cmake
# CMakeLists.txt
cmake_minimum_required(VERSION 3.16)
project(stage19_dynamic_library LANGUAGES CXX)

add_library(frame_stats SHARED frame_stats.cpp)
set_target_properties(frame_stats PROPERTIES VERSION 1.0.0 SOVERSION 1)

add_executable(vision_app main.cpp)
target_link_libraries(vision_app PRIVATE frame_stats)

# 设置 RUNPATH：从可执行文件同级目录寻找依赖库
set_target_properties(vision_app PROPERTIES
    BUILD_RPATH "$ORIGIN"
)
```

#### 编译与全景命令体检

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
./build/vision_app  # 预期正常输出 mean=25

# 检查 ELF 依赖记录
readelf -d ./build/vision_app | grep -E 'NEEDED|RUNPATH'
# 检查依赖物理路径解析结果
ldd ./build/vision_app
# 检查动态符号表导出
nm -D -C ./build/libframe_stats.so | grep frame_mean
```

#### 制造并修复运行时缺库故障

```bash
# 1. 模拟不规范部署：只拷贝了可执行程序，漏掉了 .so
mkdir -p /tmp/deploy_test
cp ./build/vision_app /tmp/deploy_test/
cd /tmp/deploy_test

# 运行必定翻车报错：error while loading shared libraries: libframe_stats.so.1
./vision_app

# 2. 正确规范修复：将伴生动态库完整复制至 $ORIGIN 同级目录
cp -a /path/to/build/libframe_stats.so* /tmp/deploy_test/

# 重新运行，成功输出结果！
./vision_app
ldd ./vision_app
```

通过这一套完整的实操闭环，我们在 Linux 系统层面构建起了从“硬件引导 -> 服务管辖 -> 进程边界 -> 零拷贝 I/O -> 动态链接”的完整技术框架，为后续承载工业级视觉流水线打下了底层工程根基。