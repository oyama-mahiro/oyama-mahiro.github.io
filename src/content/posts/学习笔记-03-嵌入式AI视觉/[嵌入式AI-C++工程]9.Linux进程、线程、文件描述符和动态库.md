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

本节建立Linux程序运行时的基本地图：系统怎样从上电走到用户程序，进程和线程怎样使用内存与内核资源，不同执行单元怎样通信，文件描述符为什么能统一表示多种I/O对象，以及动态库怎样被装入进程。重点是能够使用命令和小程序验证结论，不要求阅读完整内核源码。

阶段1-5已经介绍C++线程、互斥锁、条件变量和原子变量；阶段1-7已经介绍CMake target、动态库构建及编译期与运行期路径。本节引用这些结论，把重点放在Linux操作系统层面。

## 1 本阶段知识范围与学习目标

### 1.1 Linux系统资源与嵌入式程序的关系

一个嵌入式AI程序通常同时接触多类Linux资源：

- 摄像头、串口和加速器通过设备文件或驱动接口访问；
- 模型、配置和日志通过文件描述符读写；
- 推理线程通过共享内存和同步对象协作；
- 多进程服务通过管道、Socket或共享内存交换数据；
- OpenCV、推理引擎等代码通过动态库装入进程；
- 程序开机自启动、等待网络或等待设备，需要由系统服务管理器安排。

这些知识不是为了背系统调用，而是为了回答四类问题：资源是谁创建的、当前由谁持有、什么时候就绪、失败时去哪里找证据。

### 1.2 本阶段需要掌握的深度

完成本节后，应当能够：

1. 说明Ubuntu 22.04从上电到运行用户程序的主要阶段。
2. 找到服务、网络、挂载和设备规则的配置入口。
3. 区分进程隔离、线程共享、用户空间和内核空间。
4. 根据数据量、通信关系和时延要求选择基本通信方式。
5. 使用`/proc`、`systemctl`、`journalctl`、`ldd`、`readelf`和`nm`取得诊断证据。
6. 使用`epoll`等待多个文件描述符，并解释兴趣集合与就绪队列。
7. 区分编译链接失败、动态库加载失败和运行时符号解析失败。

页表层级、调度器算法、完整TCP服务器和动态链接器源码不在本节范围内。

## 2 RK3588上的Ubuntu 22.04从上电到启动用户程序

### 2.1 RK3588从上电到进入Linux内核

RK3588开发板上电后，CPU不能直接运行Ubuntu。此时DDR内存还不能使用，Linux内核也没有被加载。

主要过程如下：

```text
开发板上电
→ BootROM运行
→ 初始化DDR
→ 加载SPL或厂商Loader
→ 加载BL31等安全固件
→ 启动U-Boot
→ U-Boot加载Linux内核、设备树和initramfs
→ U-Boot跳转到Linux内核入口
```

首先运行的是RK3588芯片内部固化的`BootROM`。它完成最基本的芯片初始化，然后根据开发板配置，从SPI Flash、eMMC或SD卡等启动设备中寻找第一级引导程序。

此时DDR还不能使用，所以BootROM只能将较小的程序加载到芯片内部的SRAM中运行。这个程序首先配置DDR控制器并进行内存训练。DDR正常工作后，系统才有足够的内存加载后续固件。

RK3588常见两种前级启动方式：

```text
厂商方案：
BootROM → DDR初始化程序或MiniLoader → 后续固件

U-Boot方案：
BootROM → TPL → SPL → 后续固件
```

其中，TPL负责非常早期的初始化，常用于调用Rockchip提供的DDR初始化程序；SPL在DDR可用后加载安全固件和完整U-Boot。厂商镜像可能把相同工作封装成自己的Loader，因此日志中不一定出现TPL和SPL。

DDR初始化完成后，系统通常会加载ARM可信固件中的`BL31`。它负责建立RK3588的底层安全运行环境，随后把普通系统的启动权交给完整U-Boot。某些系统还会加载OP-TEE等安全系统，但它们都不是Linux进程。

U-Boot能够访问DDR和存储设备后，会加载：

- `Image`：Linux内核。
- `DTB`：描述当前RK3588开发板硬件的设备树。
- `initramfs`：Linux启动早期使用的临时根文件系统。
- `bootargs`：传给Linux内核的启动参数。

加载完成后，U-Boot跳转到Linux内核入口。到这里为止，Linux内核才正式接管CPU。不同RK3588开发板可能采用不同的固件组合和镜像布局，U-Boot官方的[Rockchip平台说明](https://docs.u-boot.org/en/stable/board/rockchip/rockchip.html)给出了TPL、SPL、BL31和完整U-Boot之间的关系。

### 2.2 Linux内核的初始化过程

U-Boot跳转到Linux内核入口时，还会把设备树和启动参数等信息交给内核。

内核初始化的主要过程是：

```text
进入Linux内核
→ 建立早期内存映射
→ 初始化CPU和内存管理
→ 初始化中断和定时器
→ 初始化进程调度器
→ 初始化内核设备模型
→ 初始化编译进内核的驱动
→ 准备进入用户空间
```

RK3588包含多个CPU核心，但启动初期通常只有一个主核心执行初始化，其他核心暂时等待。内核首先建立早期页表并启用内存管理，使程序能够通过虚拟地址访问内存。

随后，内核读取设备树。设备树描述当前开发板的CPU、内存、中断控制器、系统时钟、串口、GPIO、eMMC、PCIe和网卡等硬件。设备树只描述硬件，并不是驱动；内核根据设备树中的信息，把设备与对应驱动进行匹配。

完成基础准备后，内核进入通用初始化入口`start_kernel()`，继续初始化内存分配器、异常和中断处理、系统定时器、进程调度器、内核工作队列、虚拟文件系统、内核设备模型以及编译进内核的驱动。

这里初始化的是编译进内核的驱动。编译成`.ko`文件的驱动模块，通常要等initramfs或Ubuntu用户空间后续加载。

内核还会建立几个特殊任务：

```text
PID 0：空闲任务，CPU没有其他任务时运行
PID 1：kernel_init，负责继续进入用户空间
PID 2：kthreadd，负责创建其他内核线程
```

内核完成自身主要初始化后，就进入根文件系统准备阶段。

### 2.3 initramfs与Ubuntu根文件系统的挂载过程

内核初始化完成后，还不能直接启动Ubuntu中的程序，因为Ubuntu的文件保存在eMMC、SD卡或NVMe的根分区中。

RK3588上的Ubuntu通常使用`initramfs`。它是U-Boot提前加载到内存中的临时文件系统，里面包含启动真实Ubuntu系统所需的程序、脚本和部分驱动。

主要过程如下：

```text
内核解压initramfs
→ 将其作为临时根目录
→ 执行initramfs中的/init
→ 加载存储设备和文件系统驱动
→ 根据root=找到Ubuntu根分区
→ 挂载真实根文件系统
→ 切换到真实根文件系统
→ 执行/sbin/init
```

内核首先把initramfs解压到内存中的临时根目录，然后执行其中的`/init`。此时`/init`是第一个用户空间程序，并使用PID 1运行。它负责加载访问根分区所需的驱动，例如eMMC、SD卡、PCIe、NVMe、ext4、加密分区或LVM需要的模块。

`/init`根据内核启动参数中的`root=`确定Ubuntu根分区。例如：

```text
root=/dev/mmcblk0p2
root=UUID=xxxx-xxxx
root=PARTUUID=xxxxxxxx-02
```

设备编号可能因启动设备和驱动加载顺序变化，因此实际系统通常更适合使用`UUID`或`PARTUUID`。

找到根分区后，`/init`将其挂载到临时位置，然后使用`switch_root`或Ubuntu中的`run-init`把真实Ubuntu分区切换为新的根目录`/`。之后执行真实系统中的`/sbin/init`。

Ubuntu 22.04中的`/sbin/init`通常指向systemd。这个过程使用`exec`替换PID 1正在执行的程序，因此PID不会变化：

```text
PID 1运行initramfs中的/init
→ 挂载Ubuntu真实根文件系统
→ 切换根目录
→ PID 1继续运行systemd
```

如果系统没有initramfs，内核就必须提前包含根存储设备和文件系统驱动，然后由内核直接挂载真实根文件系统并执行`/sbin/init`。Linux内核的[initramfs文档](https://docs.kernel.org/filesystems/ramfs-rootfs-initramfs.html)说明了`/init`、真实根文件系统和PID 1之间的关系。

### 2.4 systemd启动系统服务的过程

真实根文件系统挂载完成后，PID 1开始运行systemd。systemd的主要工作是根据配置组织用户空间启动，让系统从“只有内核和根文件系统”逐步进入可使用状态。

主要过程如下：

```text
systemd成为PID 1
→ 读取单元文件
→ 运行配置生成器
→ 确定默认启动目标
→ 建立单元依赖关系
→ 启动早期系统组件
→ 挂载其他文件系统
→ 启动网络和基础服务
→ 启动登录界面和用户程序
```

systemd把自己管理的对象称为**单元（unit）**。常见单元包括：

| 单元类型 | 作用 |
|---|---|
| `.service` | 启动和管理一个服务程序 |
| `.mount` | 挂载一个文件系统 |
| `.device` | 表示内核发现的设备 |
| `.socket` | 创建并监听Socket |
| `.timer` | 定时启动任务 |
| `.target` | 表示一组希望达到的系统状态 |

systemd读取的主要配置位置包括：

```text
/usr/lib/systemd/system/或/lib/systemd/system/
    软件包提供的单元

/etc/systemd/system/
    管理员创建的单元和覆盖配置

/run/systemd/system/
    本次启动临时生成的单元
```

systemd不会按照配置文件名称逐个执行，而是根据依赖关系建立启动任务。`Wants=`和`Requires=`决定是否把另一个单元加入启动任务，`After=`和`Before=`只决定先后顺序。没有先后依赖的服务可以并行启动，因此Ubuntu没有一份严格固定的服务执行列表。

systemd除了启动服务，还会在系统运行期间监控服务状态、根据配置重启异常退出的服务、保存子进程退出状态，并在关机时按顺序停止服务和卸载文件系统。

需要注意，systemd是启动组织者，但不是所有工作的实际执行者。例如：

```text
systemd启动网络管理程序
→ 网络管理程序配置IP

systemd启动systemd-udevd
→ systemd-udevd处理设备事件

systemd启动用户服务
→ 用户程序执行具体业务
```

### 2.5 Ubuntu启动过程中常见配置及其负责组件

Ubuntu启动时使用的配置并不全由systemd处理。下面按照大致时间顺序说明每类配置由谁读取、由谁启动，以及在什么阶段生效。进入systemd阶段后，没有先后依赖的任务可能并行执行，因此这里表示阶段顺序，不是所有程序严格逐个执行的顺序。

#### 2.5.1 U-Boot阶段的内核启动参数

**处理者：**U-Boot。  
**启动者：**RK3588前面的BootROM、Loader和安全固件。  
**处理时间：**Linux内核运行之前。

部分RK3588镜像使用`/boot/extlinux/extlinux.conf`保存启动项。例如：

```text
LABEL Ubuntu
    LINUX /Image
    FDT /dtb/rockchip/board-rk3588.dtb
    INITRD /initrd.img

    # root指定Ubuntu根分区，rootwait表示等待存储设备出现。
    APPEND root=PARTUUID=xxxxxxxx-02 rootwait rw console=ttyS2,1500000
```

这部分不是systemd配置，因为这时systemd还没有启动。不同RK3588开发板也可能使用U-Boot环境变量、独立boot分区或厂商参数分区。

#### 2.5.2 initramfs阶段的根文件系统配置

**处理者：**initramfs中的`/init`。  
**启动者：**Linux内核。  
**处理时间：**内核初始化完成后、systemd启动之前。

这一阶段主要使用U-Boot传入的`root=`、`rootwait`和`rootfstype=`等参数，确定Ubuntu根分区的位置、是否等待存储设备以及根分区使用的文件系统。initramfs找到根分区后，将其挂载为`/`，然后执行其中的systemd。

#### 2.5.3 systemd启动初期的配置生成

**处理者：**systemd生成器。  
**启动者：**PID 1的systemd。  
**处理时间：**systemd刚启动、建立单元依赖关系时。

生成器只运行很短时间，用于把普通配置转换成systemd能够管理的运行时配置。常见生成器包括：

- `systemd-fstab-generator`：读取`/etc/fstab`，生成`.mount`和`.swap`单元。
- Netplan生成器：读取`/etc/netplan/*.yaml`，生成`systemd-networkd`或NetworkManager能够使用的配置。

生成配置不代表实际操作已经完成：

```text
fstab生成器生成挂载单元
→ systemd稍后执行挂载

Netplan生成网络后端配置
→ 网络后端稍后配置网卡
```

Netplan官方文档也将其职责定义为把YAML转换成网络后端配置，而不是直接长期管理网卡，参见[Netplan生成过程](https://netplan.readthedocs.io/en/stable/netplan-generate/)。

#### 2.5.4 早期系统初始化配置

systemd建立启动任务后，会启动日志、设备、模块、内核参数和临时目录等基础组件。这些组件可能根据依赖关系并行运行。

| 配置内容 | 配置位置 | 处理者 | 启动时间 |
|---|---|---|---|
| 系统日志 | `/etc/systemd/journald.conf.d/*.conf` | `systemd-journald` | systemd启动早期 |
| 主动加载模块 | `/etc/modules-load.d/*.conf` | `systemd-modules-load` | 早期系统初始化 |
| 模块参数 | `/etc/modprobe.d/*.conf` | 内核模块加载工具 | 加载模块时 |
| 内核运行参数 | `/etc/sysctl.d/*.conf` | `systemd-sysctl` | 早期系统初始化 |
| 设备名称和权限 | `/etc/udev/rules.d/*.rules` | `systemd-udevd` | 设备出现时 |
| 临时目录和文件 | `/etc/tmpfiles.d/*.conf` | `systemd-tmpfiles` | 早期系统初始化 |
| 主机名 | `/etc/hostname` | systemd相关组件 | 早期系统初始化 |

例如，开机主动加载模块：

```text
# /etc/modules-load.d/vision.conf

# 开机时加载虚拟摄像头模块。
v4l2loopback
```

模块参数放在另一个位置：

```text
# /etc/modprobe.d/v4l2loopback.conf

# 加载模块时创建编号为10的虚拟摄像头。
options v4l2loopback video_nr=10 card_label=VirtualCamera
```

内核运行参数写在：

```text
# /etc/sysctl.d/90-vision.conf

# 设置最大网络接收缓冲区，单位为字节。
net.core.rmem_max = 8388608
```

设备稳定名称可以通过udev规则创建：

```udev
# /etc/udev/rules.d/90-camera.rules

# 匹配指定USB摄像头并创建/dev/vision_camera。
SUBSYSTEM=="video4linux", ATTRS{idVendor}=="1234", ATTRS{idProduct}=="5678", SYMLINK+="vision_camera"
```

这里的实际关系是：

```text
Linux内核和驱动发现设备
→ systemd-udevd接收设备事件
→ udev规则设置名称、权限和符号链接
```

udev负责用户空间中的设备处理，不会代替内核驱动控制硬件。

#### 2.5.5 systemd挂载其他文件系统和交换分区

**处理者：**PID 1的systemd及其`.mount`、`.swap`单元。  
**启动者：**systemd根据启动目标和依赖关系启动。  
**处理时间：**真实根文件系统已经挂载、systemd已经运行之后。

配置通常写在`/etc/fstab`：

```fstab
# 把数据分区挂载到/data。
UUID=1234-5678  /data  ext4  defaults,nofail  0  2

# 启用交换分区。
UUID=8765-4321  none  swap  sw  0  0
```

这里的挂载与2.3中的根文件系统挂载不是同一件事：

```text
第一次挂载：
内核和initramfs根据root=挂载Ubuntu根分区为/
        ↓
systemd从根分区中启动
        ↓
第二次挂载：
systemd读取/etc/fstab，挂载/data、/home等其他分区
```

根文件系统必须先挂载，否则系统无法读取`/etc/fstab`，也无法运行systemd。`/etc/fstab`中也可以存在`/`的条目，但第一次找到根分区主要依靠`root=`参数；`fstab`中的根目录条目通常继续影响挂载选项。

如果用户程序依赖某个挂载目录，可以在服务中声明：

```ini
[Unit]

# 在启动程序前等待/data/models所在文件系统完成挂载。
RequiresMountsFor=/data/models
```

#### 2.5.6 网络、DNS和时间配置

网络配置分为生成配置和执行配置两个阶段。

**Netplan配置生成：**Netplan生成器由systemd在启动初期调用，读取`/etc/netplan/*.yaml`，并把配置转换给网络后端。  
**网络配置执行：**`systemd-networkd`或NetworkManager由systemd启动，在网卡驱动和设备出现后设置IP、路由和DNS。

静态IP配置示例：

```yaml
network:
  version: 2

  # 指定由systemd-networkd管理网卡。
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
        addresses:
          - 192.168.1.1
          - 8.8.8.8
```

完整过程是：

```text
内核驱动发现网卡
→ systemd-udevd处理网卡设备事件
→ Netplan生成网络后端配置
→ systemd启动networkd或NetworkManager
→ 网络后端设置IP、网关和DNS
```

DNS通常由Netplan把配置交给网络后端，再由`systemd-resolved`等组件提供域名解析。网络可用后，systemd还可以启动`systemd-timesyncd`等时间同步服务；时间同步依赖网络，但时区配置不依赖网络。

#### 2.5.7 用户程序开机自启动配置

**处理者：**PID 1的systemd。  
**启动者：**systemd根据`.service`单元的依赖关系启动。  
**处理时间：**程序要求的文件系统、设备或网络达到指定状态之后。

自定义服务通常放在`/etc/systemd/system/vision-app.service`：

```ini
[Unit]
Description=RK3588 vision application

# 拉起网络就绪目标，并让本程序排在它之后。
Wants=network-online.target
After=network-online.target

# 等待模型目录所在文件系统挂载完成。
RequiresMountsFor=/data/models

[Service]
Type=simple

# 使用普通用户运行程序。
User=ubuntu

# 设置程序的工作目录。
WorkingDirectory=/opt/vision

# systemd启动程序时应使用绝对路径。
ExecStart=/opt/vision/bin/vision_app

# 启动程序前读取环境变量；减号表示文件不存在时不直接失败。
EnvironmentFile=-/etc/vision-app.env

# 程序异常退出后重新启动。
Restart=on-failure
RestartSec=3

[Install]

# 系统进入普通多用户状态时拉起本服务。
WantedBy=multi-user.target
```

环境变量可以单独写在`/etc/vision-app.env`：

```text
MODEL_PATH=/data/models/detect.rknn
LOG_LEVEL=info
```

修改服务后需要让systemd重新读取单元，并建立开机启动关系：

```bash
# 重新读取systemd单元文件。
sudo systemctl daemon-reload

# 将服务加入开机启动。
sudo systemctl enable vision-app.service
```

传统的`/etc/init.d/`、`/etc/rc*.d/SNNname`和`/etc/rc.local`属于旧式启动方式。Ubuntu 22.04主要使用systemd，新程序优先创建`.service`单元。`.bashrc`和`.profile`通常要等用户登录并启动Shell后才会执行，也不适合作为系统级开机自启动配置。

整个启动和配置关系可以归纳为：

```text
U-Boot
    读取内核启动参数
        ↓
Linux内核和initramfs
    挂载Ubuntu根文件系统
        ↓
systemd
    建立启动依赖并运行配置生成器
        ↓
systemd辅助组件
    处理日志、模块、内核参数、设备和临时目录
        ↓
systemd
    挂载其他文件系统
        ↓
网络管理程序
    配置IP、路由和DNS
        ↓
systemd
    按依赖关系启动用户程序
```

## 3 进程、线程、用户空间与内核空间

### 3.1 进程和线程的基本区别

进程是Linux隔离资源和虚拟地址空间的重要边界。线程是进程内部可被调度的一条执行流。两个不同进程即使某个虚拟地址数值相同，默认也不表示它们访问同一块物理内存；同一进程的线程则直接共享该进程的大部分地址空间。

创建新进程常见`fork()`和`execve()`组合：`fork()`复制当前进程的执行环境，随后子进程用`execve()`把自身替换成另一个程序。创建线程则不会换一套独立进程地址空间，C++层面的`std::thread`已在阶段1-5第1节讲解。

### 3.2 线程共享的地址空间与进程资源

同一进程的线程通常共享：

- 程序代码和全局、静态对象；
- 堆上的动态对象；
- 内存映射区域；
- 文件描述符表；
- 当前工作目录和大多数进程级信号设置。

因此一个线程关闭某个共享文件描述符，其他线程继续使用该数字就可能失败，甚至在数字被快速复用后误操作另一个资源。共享不等于线程安全：只要多个线程并发访问同一可变状态，就必须遵守阶段1-5介绍的同步规则。

### 3.3 每个线程独立拥有的运行状态和线程栈

每个线程有自己的：

- 寄存器和当前指令位置；
- 用户栈；
- 调度状态；
- 线程ID；
- `errno`和线程局部存储（thread-local storage，TLS）等线程级状态；
- 信号屏蔽字。

局部变量通常位于当前线程的栈上，但把其地址交给其他线程后，仍然可能形成共享访问；原线程退出或离开作用域后，该地址会失效。

### 3.4 用户空间与内核空间的地址隔离

Linux把普通应用运行的用户空间与内核运行的内核空间隔离。用户程序不能直接执行特权操作，也不能把任意用户指针当成内核地址访问。这样一个普通程序崩溃时，通常只终止自身，不应直接破坏整个内核。

“用户空间/内核空间”描述的是权限和地址访问边界；“用户态/内核态”描述CPU当前执行代码的特权级。系统调用、异常和中断会让CPU进入内核态处理，完成后再返回用户态。

### 3.5 系统调用如何进入内核空间

`open()`、`read()`、`write()`、`mmap()`等库接口最终会在需要时发起系统调用。简化过程是：

```text
用户代码准备系统调用号和参数
→ 执行体系结构规定的陷入指令
→ CPU切换到内核态并进入内核入口
→ 内核验证参数、权限和用户地址
→ 驱动或内核子系统完成操作
→ 返回结果或负错误码
→ C库把错误转换为-1并设置errno
```

一次系统调用会发生用户态到内核态的切换，但不必然发生进程调度切换。只有调用需要等待、时间片耗尽或出现更高优先级任务等情况，当前线程才可能被调度出去。

### 3.6 驱动程序、系统调用与用户程序的关系

驱动运行在内核空间并管理硬件。用户程序通常通过以下入口与驱动协作：

- 对设备节点调用`open/read/write/ioctl/mmap`；
- 读取或写入`/sys`中的设备属性；
- 通过专用内核子系统API，例如V4L2、DRM、ALSA或网络Socket；
- 接收设备事件。

`ioctl()`用于表达普通读写无法完整描述的设备控制操作。它的命令号、参数结构和生命周期必须以具体驱动或UAPI文档为准，不能把别的设备示例直接套用。

### 3.7 使用proc观察进程地址空间和运行状态

`/proc`是内核提供的虚拟文件系统，不是磁盘上保存的一批普通日志。常用入口：

```bash
cat /proc/self/status       # 当前Shell派生工具自身的进程状态
cat /proc/<PID>/maps        # 地址映射、权限和映射文件
ls -l /proc/<PID>/fd        # 文件描述符及其目标
cat /proc/<PID>/cmdline     # 启动参数，字段以NUL分隔
cat /proc/<PID>/limits      # 文件描述符等资源限制
cat /proc/<PID>/task/<TID>/status  # 某个线程状态
```

查看其他用户或受保护进程可能被权限、容器命名空间或安全策略限制。`maps`展示的是虚拟地址区间，不直接等于实际常驻物理内存。

## 4 进程通信与线程通信方式

### 4.1 进程通信与线程通信的区别及选择依据

同一进程中的线程共享地址空间，所以线程可以直接访问同一个C++对象，再用互斥锁、条件变量或原子变量保证访问顺序。不同进程的地址空间默认相互隔离，普通指针不能跨进程使用，必须通过进程间通信（Inter-Process Communication，IPC）让内核传递数据，或者把同一个内核对象映射到双方地址空间。

常见通信方式的作用如下：

| 通信方式 | 主要作用 | 典型场景 | 主要限制 |
|---|---|---|---|
| 匿名管道`pipe` | 在父子进程间传递字节流 | 父进程发送任务、Shell流水线 | 默认单向，没有消息边界 |
| FIFO命名管道 | 让独立进程通过路径传递字节流 | 脚本向本机服务发送简单命令 | 双向通信和多客户端管理不方便 |
| Unix Domain Socket | 本机双向客户端/服务器通信 | 本地服务接口、多个客户端 | 需要设计协议和断线处理 |
| 共享内存 | 多个进程直接访问同一块大数据 | 图像帧、大数组、模型输入输出 | 必须另外处理同步和生命周期 |
| POSIX消息队列 | 传递有边界的小消息 | 控制命令、状态、小任务 | 容量和单条消息大小受限 |
| 信号 | 传递很小的异步事件 | 退出、重载、子进程状态 | 不适合携带业务数据 |
| 线程共享对象 | 进程内线程直接共享数据 | 线程池、生产者—消费者 | 必须避免数据竞争和永久等待 |
| `eventfd` | 用64位计数器发出事件通知 | 唤醒`epoll`、通知有新任务 | 只能传计数，不能传复杂数据 |

下面每种方式都使用一个独立小Demo。各Demo只证明当前通信机制，不通过命令行模式把所有示例塞进同一个程序。

### 4.2 匿名管道pipe的作用、场景与小Demo

匿名管道是内核维护的单向字节流。`pipe()`返回两个文件描述符：`pipefd[0]`是读端，`pipefd[1]`是写端。它通常在`fork()`前创建，子进程继承描述符后，父子进程分别保留自己需要的一端。

它适合父子进程传递少量任务、结果或日志，也适合Shell中的`producer | consumer`。它没有业务消息边界，需要双向通信时一般创建两条管道。

这个Demo由父进程写入一条文本，子进程持续读取到EOF：

```cpp
// pipe_demo.cpp：父进程通过匿名管道向子进程发送文本。
#include <cerrno>
#include <cstdlib>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>

int main()
{
    int pipe_fds[2]{};
    if (pipe(pipe_fds) == -1) {
        // pipe成功时，pipe_fds[0]是读端，pipe_fds[1]是写端。
        std::cerr << "pipe failed\n";
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        // fork失败后没有子进程接管描述符，当前进程必须关闭两端。
        close(pipe_fds[0]);
        close(pipe_fds[1]);
        std::cerr << "fork failed\n";
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        close(pipe_fds[1]); // 子进程只读取，必须关闭继承来的写端。

        char buffer[64]{};
        while (true) {
            const ssize_t size = read(pipe_fds[0], buffer, sizeof(buffer));
            // read返回正数表示实际字节数；返回0表示所有写端都已关闭，即EOF。
            if (size > 0) {
                std::cout.write(buffer, size);
                continue;
            }
            if (size == 0) {
                break; // 父进程关闭写端且数据读完，正常退出循环。
            }
            if (errno == EINTR) {
                continue; // 被信号打断但没有完成读取，重新调用read。
            }
            close(pipe_fds[0]);
            _exit(EXIT_FAILURE);
        }

        close(pipe_fds[0]);
        std::cout.flush();
        _exit(EXIT_SUCCESS);
    }

    close(pipe_fds[0]); // 父进程只写入，不保留读端。

    const char message[] = "task from parent\n";
    const ssize_t written = write(pipe_fds[1], message, sizeof(message) - 1);
    // write返回实际写入字节数；正式协议应循环处理短写和EINTR。
    const bool write_succeeded =
        written == static_cast<ssize_t>(sizeof(message) - 1);

    close(pipe_fds[1]); // 关闭最后一个写端，子进程读完后才能得到EOF。

    int child_status = 0;
    const pid_t waited = waitpid(child_pid, &child_status, 0);
    // waitpid回收子进程，避免退出后的子进程长期成为僵尸进程。

    return write_succeeded && waited == child_pid &&
                   WIFEXITED(child_status) &&
                   WEXITSTATUS(child_status) == EXIT_SUCCESS
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 编译并运行匿名管道Demo。
g++ -std=c++17 -Wall -Wextra -pedantic pipe_demo.cpp -o pipe_demo
./pipe_demo
```

预期输出是`task from parent`。如果子进程不关闭继承的`pipe_fds[1]`，即使父进程关闭写端，读端也不会得到EOF，这会造成永久等待。

### 4.3 FIFO命名管道的作用、场景与小Demo

FIFO（First In, First Out）又称命名管道。它和匿名管道一样传递字节流，但在文件系统中有一个路径，因此两个分别启动、没有父子关系的进程也能连接。

FIFO适合脚本向后台程序发送简单文本、两个固定本机程序之间进行低复杂度单向通信。需要双向请求响应时通常要创建两个FIFO；需要多个客户端身份和连接管理时更适合Unix Domain Socket。

这个Demo由两个独立程序组成。先运行读取端，它创建FIFO并等待写入端：

```cpp
// fifo_reader.cpp：创建并读取命名管道。
#include <cerrno>
#include <cstdlib>
#include <iostream>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

int main()
{
    constexpr const char* kPath = "/tmp/vision_demo_fifo";

    if (mkfifo(kPath, 0600) == -1 && errno != EEXIST) {
        // mkfifo创建文件系统入口；EEXIST表示路径已经存在，可继续尝试打开。
        std::cerr << "mkfifo failed\n";
        return EXIT_FAILURE;
    }

    const int fd = open(kPath, O_RDONLY);
    // 默认阻塞模式下，open读端会等待至少一个写端打开FIFO。
    if (fd == -1) {
        std::cerr << "open read end failed\n";
        return EXIT_FAILURE;
    }

    char buffer[64]{};
    const ssize_t size = read(fd, buffer, sizeof(buffer));
    // read返回0表示当前所有写端已经关闭，返回-1表示失败。
    if (size > 0) {
        std::cout.write(buffer, size);
    }

    close(fd);    // 关闭当前进程的FIFO描述符。
    unlink(kPath); // 删除FIFO路径；应由约定的创建者负责清理。
    return size >= 0 ? EXIT_SUCCESS : EXIT_FAILURE;
}
```

写入端打开同一路径并发送一条消息：

```cpp
// fifo_writer.cpp：打开已有FIFO并写入文本。
#include <cstdlib>
#include <iostream>
#include <fcntl.h>
#include <unistd.h>

int main()
{
    const int fd = open("/tmp/vision_demo_fifo", O_WRONLY);
    // 默认阻塞模式下，open写端会等待读取端出现；失败返回-1。
    if (fd == -1) {
        std::cerr << "open write end failed\n";
        return EXIT_FAILURE;
    }

    const char message[] = "command through FIFO\n";
    const ssize_t size = write(fd, message, sizeof(message) - 1);
    // 小Demo只发送一条短消息；正式代码仍应处理短写、EINTR和EPIPE。

    close(fd); // 写端关闭后，读取端读完现有数据便能看到EOF。
    return size == static_cast<ssize_t>(sizeof(message) - 1)
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 分别编译两个独立进程。
g++ -std=c++17 -Wall -Wextra -pedantic fifo_reader.cpp -o fifo_reader
g++ -std=c++17 -Wall -Wextra -pedantic fifo_writer.cpp -o fifo_writer

# 终端1先运行读取端；终端2再运行写入端。
./fifo_reader
./fifo_writer
```

默认阻塞模式下，任意一端单独启动都可能等待对端。使用`O_NONBLOCK`可以避免永久等待，但必须处理`ENXIO`、`EAGAIN`和重新连接。

### 4.4 Unix Domain Socket的作用、场景与小Demo

Unix Domain Socket是只在本机使用的Socket，支持双向通信。它适合本地守护进程提供控制接口、多个客户端请求服务，以及需要传递对端凭据或文件描述符的场景。

独立客户端和服务端通常使用`socket → bind → listen → accept`与`connect`。下面的小Demo使用`socketpair()`直接创建一对已经连接的本地Socket，用最少代码展示双向请求响应。`SOCK_SEQPACKET`会保留每次发送的消息边界。

```cpp
// unix_socket_demo.cpp：父子进程通过Unix Domain Socket双向通信。
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

int main()
{
    int sockets[2]{};
    if (socketpair(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0, sockets) == -1) {
        // 成功时两个描述符都可读写，并连接到彼此。
        std::cerr << "socketpair failed\n";
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        close(sockets[0]);
        close(sockets[1]);
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        close(sockets[0]); // 子进程只保留自己这一端。

        char request[64]{};
        const ssize_t request_size = recv(sockets[1], request, sizeof(request), 0);
        // recv返回收到的消息字节数，0表示对端已经正常关闭连接。
        if (request_size <= 0) {
            close(sockets[1]);
            _exit(EXIT_FAILURE);
        }

        const char reply[] = "child accepted request";
        const ssize_t sent = send(sockets[1], reply, sizeof(reply) - 1, 0);
        // send返回实际发送字节数；失败返回-1。
        close(sockets[1]);
        _exit(sent == static_cast<ssize_t>(sizeof(reply) - 1)
                  ? EXIT_SUCCESS
                  : EXIT_FAILURE);
    }

    close(sockets[1]); // 父进程只保留另一端。

    const char request[] = "reload model";
    const ssize_t request_sent =
        send(sockets[0], request, sizeof(request) - 1, 0);
    if (request_sent != static_cast<ssize_t>(sizeof(request) - 1)) {
        // 这条定长请求没有完整发送时，关闭连接让子进程停止等待后再回收。
        close(sockets[0]);
        waitpid(child_pid, nullptr, 0);
        return EXIT_FAILURE;
    }

    char reply[64]{};
    const ssize_t reply_size = recv(sockets[0], reply, sizeof(reply), 0);
    if (reply_size > 0) {
        std::cout.write(reply, reply_size);
        std::cout << '\n';
    }

    close(sockets[0]);
    int status = 0;
    waitpid(child_pid, &status, 0);
    return reply_size > 0 && WIFEXITED(status) &&
                   WEXITSTATUS(status) == EXIT_SUCCESS
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 编译并运行本地Socket Demo。
g++ -std=c++17 -Wall -Wextra -pedantic unix_socket_demo.cpp -o unix_socket_demo
./unix_socket_demo
```

预期输出是`child accepted request`。实际守护进程若改用`SOCK_STREAM`，必须额外使用固定长度、长度字段或分隔符定义消息边界，不能假设一次`send()`对应一次`recv()`。

### 4.5 POSIX共享内存与mmap的作用、场景与小Demo

共享内存让多个进程把同一个内核对象映射进各自地址空间。数据写入共享区域后，不需要通过管道或Socket再复制一遍，因此适合图像帧、模型输入输出和大型数组。

共享内存只解决“双方访问同一块数据”，不会自动提供互斥和完成通知。真实项目通常还要配合进程共享信号量、Socket或`eventfd`。共享区域中的结构还必须约定版本、总大小和字段含义，不能直接保存只在当前进程有效的普通指针。

这个Demo由父进程创建并写入POSIX命名共享内存，子进程按名称重新打开并读取：

```cpp
// shared_memory_demo.cpp：两个进程通过命名共享内存访问同一份状态。
#include <cstdio>
#include <cstdlib>
#include <iostream>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

struct SharedState {
    unsigned int frame_id; // 共享的任务编号。
    char status[64];       // 固定容量文本，避免保存跨进程无效的char*指针。
};

int main()
{
    constexpr const char* kName = "/vision_shared_state_demo";

    // O_EXCL避免悄悄复用上次异常退出遗留的同名对象。
    const int owner_fd =
        shm_open(kName, O_CREAT | O_EXCL | O_RDWR | O_CLOEXEC, 0600);
    if (owner_fd == -1) {
        std::cerr << "shm_open create failed\n";
        return EXIT_FAILURE;
    }

    if (ftruncate(owner_fd, sizeof(SharedState)) == -1) {
        // 新共享内存对象长度通常为0，映射前必须设置实际大小。
        close(owner_fd);
        shm_unlink(kName);
        return EXIT_FAILURE;
    }

    void* owner_address = mmap(nullptr, sizeof(SharedState),
                               PROT_READ | PROT_WRITE,
                               MAP_SHARED, owner_fd, 0);
    // mmap失败返回MAP_FAILED，不是nullptr。
    if (owner_address == MAP_FAILED) {
        close(owner_fd);
        shm_unlink(kName);
        return EXIT_FAILURE;
    }

    auto* owner_state = static_cast<SharedState*>(owner_address);
    owner_state->frame_id = 42;
    std::snprintf(owner_state->status, sizeof(owner_state->status), "%s", "ready");
    // 数据在fork前已经写完，所以子进程读取时不需要额外的并发同步。

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        munmap(owner_address, sizeof(SharedState));
        close(owner_fd);
        shm_unlink(kName);
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        // 为了证明“可以通过名称重新连接”，子进程先丢弃继承的映射和描述符。
        munmap(owner_address, sizeof(SharedState));
        close(owner_fd);

        const int reader_fd = shm_open(kName, O_RDONLY | O_CLOEXEC, 0);
        if (reader_fd == -1) {
            _exit(EXIT_FAILURE);
        }

        void* reader_address = mmap(nullptr, sizeof(SharedState),
                                    PROT_READ, MAP_SHARED, reader_fd, 0);
        if (reader_address == MAP_FAILED) {
            close(reader_fd);
            _exit(EXIT_FAILURE);
        }

        const auto* state = static_cast<const SharedState*>(reader_address);
        std::cout << "frame=" << state->frame_id
                  << ", status=" << state->status << std::endl;

        munmap(reader_address, sizeof(SharedState)); // 解除当前进程映射。
        close(reader_fd);                            // 关闭当前描述符。
        _exit(EXIT_SUCCESS);
    }

    int status = 0;
    waitpid(child_pid, &status, 0);

    munmap(owner_address, sizeof(SharedState));
    close(owner_fd);
    shm_unlink(kName); // 创建者在双方使用结束后删除共享内存名称。

    return WIFEXITED(status) && WEXITSTATUS(status) == EXIT_SUCCESS
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 新版glibc通常不再需要-lrt；较老环境可在命令末尾增加-lrt。
g++ -std=c++17 -Wall -Wextra -pedantic shared_memory_demo.cpp -o shared_memory_demo
./shared_memory_demo
```

预期输出是`frame=42, status=ready`。这个Demo在`fork()`前写完数据，因此没有并发读写；如果父子进程同时更新共享区域，必须再加入明确支持进程共享的同步机制。

### 4.6 POSIX消息队列的作用、场景与小Demo

POSIX消息队列由内核保存一条条独立消息，并保留消息边界和优先级。它适合传递“重新加载模型”“切换模式”和小型任务描述，不适合直接传递大图像。

队列具有最大消息数和单条消息大小。队列满时，阻塞模式会等待空间，非阻塞模式返回`EAGAIN`，所以程序必须规定等待、丢弃还是报告失败。

这个Demo在`fork()`前创建队列，父进程发送一条命令，子进程接收：

```cpp
// message_queue_demo.cpp：父子进程通过POSIX消息队列传递一条完整命令。
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <fcntl.h>
#include <mqueue.h>
#include <signal.h>
#include <string>
#include <sys/wait.h>
#include <unistd.h>

int main()
{
    const std::string queue_name =
        "/vision_command_" + std::to_string(static_cast<long long>(getpid()));

    struct mq_attr attributes{};
    attributes.mq_maxmsg = 4;  // 队列最多保存4条消息。
    attributes.mq_msgsize = 64; // 每条消息最多64字节。

    const mqd_t queue = mq_open(queue_name.c_str(),
                                O_CREAT | O_EXCL | O_RDWR,
                                0600, &attributes);
    // mq_open失败返回(mqd_t)-1；O_EXCL防止复用同名旧队列。
    if (queue == static_cast<mqd_t>(-1)) {
        std::cerr << "mq_open failed\n";
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        mq_close(queue);
        mq_unlink(queue_name.c_str());
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        char message[64]{}; // 容量必须不小于队列的mq_msgsize。
        unsigned int priority = 0;
        const ssize_t size = mq_receive(queue, message, sizeof(message), &priority);
        // mq_receive一次取得一条完整消息；阻塞模式下会等待消息出现。
        if (size == -1) {
            mq_close(queue);
            _exit(EXIT_FAILURE);
        }

        std::cout << "command=" << message
                  << ", priority=" << priority << std::endl;
        mq_close(queue); // 只关闭子进程的队列描述符，不删除队列名称。
        _exit(EXIT_SUCCESS);
    }

    const char command[] = "reload-model";
    const int send_result = mq_send(queue, command, sizeof(command), 5);
    // mq_send成功返回0；最后一个参数5是这条消息的优先级。

    if (send_result == -1) {
        // 发送失败时子进程仍可能阻塞在mq_receive，必须通知它退出后再回收。
        kill(child_pid, SIGTERM);
    }

    int status = 0;
    waitpid(child_pid, &status, 0);

    mq_close(queue);                    // 父进程关闭自己的描述符。
    mq_unlink(queue_name.c_str());      // 创建者删除名称，避免系统中残留队列。

    return send_result == 0 && WIFEXITED(status) &&
                   WEXITSTATUS(status) == EXIT_SUCCESS
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 较老Linux环境如果链接失败，在命令末尾增加-lrt。
g++ -std=c++17 -Wall -Wextra -pedantic message_queue_demo.cpp -o message_queue_demo
./message_queue_demo
```

预期输出包含`command=reload-model, priority=5`。实际项目还要处理队列满、接收缓冲区过小、创建者崩溃后名称残留等情况。

### 4.7 信号的作用、场景与小Demo

信号用于向进程或线程发送很小的事件，适合请求退出、重新读取配置、报告定时器到期或通知子进程状态变化。信号不适合传输图像、字符串或复杂结构。

异步信号处理函数可能打断任意代码，只能调用异步信号安全的操作。多线程程序通常更适合先屏蔽目标信号，再由专门线程使用`sigwait()`同步等待。下面Demo也使用这种方式，避免在处理函数中执行复杂逻辑。

```cpp
// signal_demo.cpp：父进程用SIGUSR1通知子进程执行一次动作。
#include <signal.h>
#include <cstdlib>
#include <iostream>
#include <sys/wait.h>
#include <unistd.h>

int main()
{
    sigset_t signal_set;
    sigemptyset(&signal_set);            // 先创建空信号集合。
    sigaddset(&signal_set, SIGUSR1);     // 把本Demo使用的SIGUSR1加入集合。

    if (sigprocmask(SIG_BLOCK, &signal_set, nullptr) == -1) {
        // fork前屏蔽SIGUSR1，父子进程都会继承屏蔽状态，避免通知过早丢失。
        std::cerr << "sigprocmask failed\n";
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        int received_signal = 0;
        const int wait_result = sigwait(&signal_set, &received_signal);
        // sigwait同步取得集合中的一个待处理信号；成功直接返回0，不使用errno。
        if (wait_result != 0) {
            _exit(EXIT_FAILURE);
        }

        std::cout << "child received signal "
                  << received_signal << std::endl;
        _exit(EXIT_SUCCESS);
    }

    const int send_result = kill(child_pid, SIGUSR1);
    // kill向指定PID发送信号；成功返回0，失败返回-1。

    if (send_result == -1) {
        // 首次发送失败时避免子进程永久等待；SIGKILL不要求目标进程安装处理方式。
        kill(child_pid, SIGKILL);
    }

    int status = 0;
    waitpid(child_pid, &status, 0);
    return send_result == 0 && WIFEXITED(status) &&
                   WEXITSTATUS(status) == EXIT_SUCCESS
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 编译并运行信号通知Demo。
g++ -std=c++17 -Wall -Wextra -pedantic signal_demo.cpp -o signal_demo
./signal_demo
```

输出中的信号编号由系统定义。这里的信号只表示“事件发生”，真正的任务内容应放在其他共享状态或通信通道中。

### 4.8 线程共享对象的作用、场景与小Demo

同一进程中的线程可以直接访问同一个C++对象，因此通常不需要使用进程IPC。典型做法是把任务放入受互斥锁保护的队列，再用条件变量通知消费者。

这种方式适合线程池、采集—推理流水线和进程内生产者—消费者。线程之间没有进程级故障隔离，一个线程发生非法内存访问可能导致整个进程退出。

下面Demo中，生产者放入三个任务并设置关闭状态，消费者持续处理到“队列为空且已经关闭”为止：

```cpp
// thread_queue_demo.cpp：两个线程通过共享队列、互斥锁和条件变量通信。
#include <condition_variable>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <queue>
#include <thread>

struct SharedQueue {
    std::mutex mutex;              // 保护tasks和closed，所有读写都必须持有它。
    std::condition_variable ready; // 有新任务或关闭状态改变时唤醒消费者。
    std::queue<int> tasks;         // 生产者写入、消费者取出的共享任务。
    bool closed = false;           // 由生产者写入，表示以后不会再有新任务。
};

int main()
{
    SharedQueue shared;

    std::thread consumer([&shared] {
        while (true) {
            std::unique_lock<std::mutex> lock(shared.mutex);
            shared.ready.wait(lock, [&shared] {
                // 带条件等待可以处理虚假唤醒；条件不成立时继续休眠。
                return !shared.tasks.empty() || shared.closed;
            });

            if (shared.tasks.empty() && shared.closed) {
                // 队列已经排空且不会再加入任务，消费者安全退出。
                break;
            }

            const int task = shared.tasks.front();
            shared.tasks.pop();
            lock.unlock(); // 处理任务前释放锁，避免阻塞生产者加入后续任务。

            std::cout << "consume task " << task << '\n';
        }
    });

    std::thread producer([&shared] {
        for (int task = 1; task <= 3; ++task) {
            {
                std::lock_guard<std::mutex> lock(shared.mutex);
                shared.tasks.push(task); // 持锁修改标准库队列，避免数据竞争。
            }
            shared.ready.notify_one(); // 修改完成后唤醒一个消费者。
        }

        {
            std::lock_guard<std::mutex> lock(shared.mutex);
            shared.closed = true; // 在同一把锁保护下发布关闭状态。
        }
        shared.ready.notify_all(); // 唤醒所有等待者，让它们观察关闭状态。
    });

    producer.join(); // 等待生产者结束，保证shared仍然存活。
    consumer.join(); // 等待消费者排空队列并退出。
    return EXIT_SUCCESS;
}
```

```bash
# -pthread同时启用编译和链接所需的线程支持。
g++ -std=c++17 -Wall -Wextra -pedantic -pthread thread_queue_demo.cpp -o thread_queue_demo
./thread_queue_demo
```

预期依次输出任务1、2、3。完整的有限队列、背压和`close()`语义已经在阶段1-6说明；这里的小Demo只展示线程共享状态的基本通信关系。

### 4.9 eventfd的作用、场景与小Demo

`eventfd()`创建一个由内核维护的64位无符号计数器，并返回文件描述符。写入一个整数会增加计数，读取会取得当前计数并在默认模式下清零。

它适合通知“有几个新任务”、唤醒阻塞在`epoll_wait()`中的事件循环，或者发出停止请求。复杂任务内容仍应放在共享队列或共享内存中，`eventfd`只负责计数通知。

这个Demo在`fork()`前创建`eventfd`，父进程写入3，子进程阻塞读取同一个内核计数器：

```cpp
// eventfd_demo.cpp：父进程通过eventfd向子进程发送计数通知。
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <signal.h>
#include <sys/eventfd.h>
#include <sys/wait.h>
#include <unistd.h>

int main()
{
    const int event_fd = eventfd(0, EFD_CLOEXEC);
    // 初始计数为0；未使用NONBLOCK，所以计数为0时read会阻塞等待。
    // CLOEXEC避免该描述符泄漏给以后通过exec启动的其他程序。
    if (event_fd == -1) {
        std::cerr << "eventfd failed\n";
        return EXIT_FAILURE;
    }

    const pid_t child_pid = fork();
    if (child_pid == -1) {
        close(event_fd);
        return EXIT_FAILURE;
    }

    if (child_pid == 0) {
        std::uint64_t observed_count = 0;
        const ssize_t size =
            read(event_fd, &observed_count, sizeof(observed_count));
        // eventfd要求一次读取完整的8字节整数；成功返回8。
        if (size != static_cast<ssize_t>(sizeof(observed_count))) {
            close(event_fd);
            _exit(EXIT_FAILURE);
        }

        std::cout << "child observed "
                  << observed_count << " events" << std::endl;
        close(event_fd);
        _exit(EXIT_SUCCESS);
    }

    const std::uint64_t increment = 3;
    const ssize_t size = write(event_fd, &increment, sizeof(increment));
    // eventfd要求一次写入完整的8字节整数；写入3使计数从0变为3。

    if (size != static_cast<ssize_t>(sizeof(increment))) {
        // 写入失败时子进程仍可能阻塞在read，必须结束它后再调用waitpid。
        kill(child_pid, SIGTERM);
    }

    int status = 0;
    waitpid(child_pid, &status, 0);
    close(event_fd);

    return size == static_cast<ssize_t>(sizeof(increment)) &&
                   WIFEXITED(status) &&
                   WEXITSTATUS(status) == EXIT_SUCCESS
               ? EXIT_SUCCESS
               : EXIT_FAILURE;
}
```

```bash
# 编译并运行eventfd计数通知Demo。
g++ -std=c++17 -Wall -Wextra -pedantic eventfd_demo.cpp -o eventfd_demo
./eventfd_demo
```

预期输出是`child observed 3 events`。如果使用`EFD_NONBLOCK`，计数为0时读取不会等待，而是返回`-1`并将`errno`设置为`EAGAIN`。

### 4.10 通信方式的选择方法

可以按照下面的顺序选择：

1. 同一进程中的线程共享任务，优先使用受保护队列、条件变量或原子状态。
2. 父子进程只需要单向字节流，优先考虑匿名管道。
3. 两个独立进程只需要一个简单字节流入口，可以使用FIFO。
4. 需要双向通信、多个客户端或长期服务，使用Unix Domain Socket。
5. 需要传递图像等大块数据，使用共享内存保存数据，再配合Socket、信号量或`eventfd`通知。
6. 需要传递有边界的小命令，可以使用POSIX消息队列。
7. 只需要退出或重载等事件，可以使用信号。
8. 只需要把事件循环从`epoll_wait()`中唤醒，可以使用`eventfd`。

无论选择哪一种方式，都应提前定义消息格式、最大长度、超时、队列满策略、对端退出行为，以及资源由谁创建、由谁删除。通信API调用成功只能说明内核接受了字节或事件，不代表业务消息一定完整、版本一定兼容。

## 5 虚拟内存、页与mmap内存映射

### 5.1 虚拟地址和物理内存的关系

程序中的指针通常保存虚拟地址。CPU和内核通过页表把虚拟页映射到物理页或其他后备存储。每个进程拥有自己的虚拟地址空间视图，因此进程隔离、共享库复用、内存保护和按需加载都可以在这层实现。

“虚拟地址连续”只表示地址数值连续，不保证背后的物理页连续。阶段1-3讨论`cv::Mat`连续性时，关注的是程序可见的行布局；需要DMA物理连续性时必须使用驱动提供的专用分配和映射接口，不能靠普通`new`或`mmap`猜测。

### 5.2 内存页的作用

页（page）是虚拟内存映射和保护的基本粒度之一。常见系统页大小是4 KiB，但不能硬编码，可以查询：

```bash
getconf PAGE_SIZE
```

程序访问尚未建立有效映射的页时会触发缺页异常，由内核决定装入文件内容、分配匿名页或报告错误。缺页不一定是程序错误；第一次访问文件映射时发生按需装入是正常机制。

### 5.3 mmap的文件映射和匿名映射

`mmap()`把文件区间或匿名内存映射进调用进程的虚拟地址空间：

```cpp
#include <sys/mman.h>

void* mmap(void* address, size_t length, int protection,
           int flags, int fd, off_t offset);
int munmap(void* address, size_t length);
```

关键参数：

- `length`：映射字节数，不能为0。
- `PROT_READ/PROT_WRITE`：允许的访问方式，必须与文件打开权限协调。
- `MAP_PRIVATE`：写入使用私有写时复制，不回写给其他映射者。
- `MAP_SHARED`：修改对同一映射对象可见，并可按规则回写文件。
- `MAP_ANONYMOUS`：不关联普通文件，此时通常传`fd=-1`、`offset=0`。

失败返回`MAP_FAILED`，不是`nullptr`。文件偏移必须满足页对齐要求。详细接口边界见[`mmap(2)`](https://man7.org/linux/man-pages/man2/mmap.2.html)。

### 5.4 mmap在模型文件和共享内存中的用途

映射模型文件后，程序可以像访问内存一样读取内容，内核按访问需要装入页面，并统一利用页缓存。它的优势是减少显式`read()`循环和额外用户缓冲区，不等于“整个模型立刻零成本进入物理内存”。第一次访问仍可能产生I/O和缺页延迟。

共享内存映射则让多个进程把同一后备对象映射到各自虚拟地址空间。每个进程获得的虚拟地址可能不同，因此共享结构中不要保存只对某一进程有效的裸指针；应使用相对偏移、固定布局和版本字段。

### 5.5 mmap权限、同步和解除映射

典型文件映射流程是：

```cpp
int fd = open(model_path, O_RDONLY | O_CLOEXEC);
void* data = mmap(nullptr, file_size, PROT_READ, MAP_PRIVATE, fd, 0);
// 映射建立后可以关闭fd；映射本身继续持有对底层文件的引用。
close(fd);

// 使用data之前必须确认mmap没有返回MAP_FAILED。
// 完成后用最初的地址和长度解除映射。
munmap(data, file_size);
```

需要注意：

- 映射长度超过当前文件末尾并访问无有效后备的页面，可能收到`SIGBUS`。
- 其他进程在映射期间截断文件，也可能让现有访问失败。
- `MAP_SHARED`写文件时，如需明确持久化时机可研究`msync()`，但还要考虑文件系统和存储设备语义。
- `munmap()`后所有指向该区域的指针、视图和引用立即失效。

### 5.6 使用proc查看进程内存映射

```bash
cat /proc/<PID>/maps
pmap -x <PID>
```

`maps`每行包含地址范围、权限、文件偏移、设备、inode和可选路径。权限中的`rwx`分别表示读、写、执行，最后的`p/s`表示私有或共享映射。可以从中找到可执行文件、堆、线程栈、动态库和匿名区域。

不能只把所有地址区间长度相加就当成物理内存占用。虚拟大小、常驻集合、共享页和按需未触碰页是不同指标；精确分析可结合`/proc/<PID>/smaps`。

## 6 文件描述符与Linux统一I/O模型

### 6.1 文件描述符与打开文件描述的关系

文件描述符（file descriptor，fd）是当前进程文件描述符表中的一个非负整数索引。`open()`还会创建或引用内核中的“打开文件描述”（open file description），其中保存当前文件偏移和状态标志。多个fd可能通过`dup()`或进程继承指向同一个打开文件描述，因此共享文件偏移。

这三者不要混淆：

```text
路径名 /data/model.bin
        ↓ open
进程中的fd数字 3
        ↓ 引用
内核打开文件描述（偏移、状态标志）
        ↓ 关联
文件系统对象或其他内核I/O对象
```

路径被删除后，已经打开的fd仍可能继续访问原对象，直到最后一个引用关闭。详见[`open(2)`](https://man7.org/linux/man-pages/man2/open.2.html)。

### 6.2 open、read、write和close的资源生命周期

常见流程是：

```cpp
#include <fcntl.h>
#include <unistd.h>

int fd = open("/data/state.bin", O_RDONLY | O_CLOEXEC);
if (fd == -1) {
    // 打开失败，检查errno；不能继续read或close这个返回值。
}

char buffer[256]{};
ssize_t received = read(fd, buffer, sizeof(buffer));
// received > 0：实际读取字节数；等于0：EOF；等于-1：错误。

if (close(fd) == -1) {
    // 对需要确认落盘或网络完整性的场景，关闭错误也不能一概忽略。
}
```

`read/write`可能只完成请求的一部分，可能被信号打断，也可能在非阻塞模式返回`EAGAIN`。健壮代码必须根据返回字节数推进缓冲区，不能假设一次调用完成全部数据。

### 6.3 文件、设备、pipe和socket对应的文件描述符

同一个`read/write/close`接口能够作用于多种对象，是因为fd最终关联到相应内核对象及其操作实现：

- 普通文件：通常可定位，有文件偏移。
- 设备文件：行为由驱动决定，可能还需要`ioctl()`。
- pipe/FIFO：字节流，通常不可定位。
- Socket：网络或本机通信端点。
- eventfd：64位事件计数器。
- epoll实例：内核事件集合本身。

“都使用fd”不表示语义完全相同。例如对pipe调用`lseek()`会失败，普通磁盘文件通常不能作为有意义的`epoll`监控对象，设备是否支持`mmap`由驱动决定。

### 6.4 eventfd和epoll自身为什么也是文件描述符

`eventfd()`和`epoll_create1()`都会返回fd，所以它们具有统一生命周期：可以设置`CLOEXEC`、可以被`close()`释放，也可以在适用时被其他等待接口监控。

epoll fd代表“一组监控关系和就绪状态”，不是某个业务Socket。关闭epoll fd会释放该epoll实例；关闭某个被监控fd时，还要考虑同一打开文件描述是否存在其他重复fd，以及应用自己的事件数据是否仍保存了过期指针。

### 6.5 文件描述符继承与CLOEXEC

`fork()`后的子进程继承父进程当前打开的fd，它们指向相同的打开文件描述。随后执行`execve()`时，未设置close-on-exec的fd默认仍会保留到新程序中。

无意继承会造成：

- 管道写端一直存在，读端永远等不到EOF；
- 子进程持有监听Socket或敏感文件；
- 服务重启后旧资源仍被其他程序占用。

创建资源时优先原子地指定`O_CLOEXEC`、`SOCK_CLOEXEC`、`EFD_CLOEXEC`、`EPOLL_CLOEXEC`或使用`pipe2(O_CLOEXEC)`。在多线程程序中先创建再单独`fcntl()`设置，中间存在另一个线程执行`fork/exec`的竞态窗口。

### 6.6 使用proc检查文件描述符泄漏

```bash
ls -l /proc/<PID>/fd
cat /proc/<PID>/limits | grep -i 'open files'
lsof -p <PID>
```

`/proc/<PID>/fd/N`是符号链接，可能显示普通路径、`socket:[inode]`、`pipe:[inode]`、`anon_inode:[eventpoll]`或`anon_inode:[eventfd]`。持续重复同一操作并观察fd数量不断增长，是泄漏的重要证据。

进程出现`Too many open files`或`EMFILE`时，不应先盲目增大限制。先按fd类型和业务操作找到未关闭路径；提高限制只会推迟故障，并可能扩大资源占用。

## 7 epoll的工作原理与使用方法

### 7.1 epoll解决的I/O等待问题

一个线程如果依次对许多阻塞Socket调用`read()`，会停在第一个没有数据的连接上。`select/poll/epoll`这类I/O多路复用接口允许线程等待“一组fd中任意一个就绪”，再只处理已就绪对象。

epoll是Linux专用的I/O事件通知设施，适合长期监控大量Socket、pipe、eventfd和部分设备fd。它解决的是等待与通知，不负责创建连接、读取完整协议消息，也不会自动让业务处理并发。

### 7.2 epoll实例、兴趣集合与就绪队列

一次epoll使用涉及三类对象：

1. **epoll实例**：由`epoll_create1()`创建，用户空间用epoll fd引用。
2. **兴趣集合（interest list）**：应用通过`epoll_ctl()`登记“关心哪些fd的哪些事件”。
3. **就绪队列（ready list）**：内核把已经满足条件的监控项放入这里，`epoll_wait()`从中取回事件。

关键因果关系是：

```text
epoll_ctl登记兴趣
→ 被监控对象的状态发生变化
→ 内核的poll通知路径把对应监控项标记为就绪
→ 等待队列唤醒阻塞在epoll_wait的线程
→ epoll_wait把就绪事件复制到用户数组
→ 应用对业务fd执行read、write或accept
```

`epoll_wait()`返回“现在可以尝试什么操作”，不返回业务数据。官方[`epoll(7)`](https://man7.org/linux/man-pages/man7/epoll.7.html)把用户可见模型定义为兴趣集合和就绪队列。

### 7.3 epoll内部如何登记、发现和返回就绪事件

调用`epoll_ctl(EPOLL_CTL_ADD)`时，内核会为fd创建一个`epitem`，其中记录fd、监听事件和用户设置的`event.data`，然后将它放入epoll的红黑树。红黑树保存全部监听项，便于`epoll_ctl()`快速查找、修改和删除；`epoll_wait()`不会遍历红黑树寻找就绪fd。

随后，epoll调用目标fd的`poll()`接口，将自己的回调函数`ep_poll_callback()`登记到目标对象的等待队列。例如socket收到数据后，网络协议栈把数据放入socket接收缓冲区，并唤醒该socket的等待队列，进而执行这个回调。

回调函数先把fd对应的`epitem`加入epoll的就绪链表，再唤醒等待在`epoll_wait()`中的线程：

```text
epoll_ctl()添加fd
  → epitem进入红黑树
  → epoll回调登记到fd的等待队列
  → 驱动或协议栈使fd变为就绪
  → 等待队列执行epoll回调
  → epitem进入就绪链表
  → 唤醒epoll_wait线程
```

这里的“唤醒”不是让线程轮询某个标志，而是将线程从睡眠状态改为可运行状态，放回CPU的可运行队列。线程什么时候真正执行，由调度器决定。在它获得CPU之前，其他fd也可能继续加入就绪链表。

因此，即使多个fd连续调用了唤醒操作，通常也只有第一次把线程从睡眠改为可运行；各个就绪fd则由链表保存。线程真正运行后，`epoll_wait()`从链表取出最多`maxevents`个就绪项并返回给程序。epoll只报告事件，真正的`read()`、`recv()`或`accept()`仍由程序调用。

水平触发（Level Triggered，LT）和边缘触发（Edge Triggered，ET）的区别在于是否会重复报告仍未处理完的事件。假设socket收到100字节，程序只读取了20字节：LT下，因为缓冲区仍有80字节，下一次`epoll_wait()`还会报告这个fd；ET下，通常不会仅因为这80字节仍然存在而再次报告，因此程序应使用非阻塞fd并一次读取到`EAGAIN`。

- LT：还有数据，就继续提醒。
- ET：状态变化时提醒一次，你要一次处理干净。

红黑树、回调函数和就绪链表属于当前Linux内核的实现细节，应用程序只应依赖epoll接口规定的行为。可参考[Linux `eventpoll.c`源码](https://kernel.googlesource.com/pub/scm/linux/kernel/git/torvalds/linux/+/master/fs/eventpoll.c)理解内部流程。

### 7.4 epoll_create1创建epoll实例

```cpp
#include <sys/epoll.h>

int epoll_create1(int flags);
```

- 功能：创建epoll实例。
- 常用参数：`EPOLL_CLOEXEC`，防止执行新程序时意外继承。
- 返回值：成功返回epoll fd，失败返回-1并设置`errno`。

```cpp
int epoll_fd = epoll_create1(EPOLL_CLOEXEC);
if (epoll_fd == -1) {
    // 创建失败，没有任何epoll实例需要关闭。
}
```

不再使用时必须`close(epoll_fd)`。

### 7.5 epoll_ctl添加、修改和删除监控项

```cpp
#include <sys/epoll.h>

int epoll_ctl(int epoll_fd, int operation, int target_fd,
              epoll_event* event);
```

`operation`常用值：

- `EPOLL_CTL_ADD`：把`target_fd`加入兴趣集合。
- `EPOLL_CTL_MOD`：修改已登记事件和用户数据。
- `EPOLL_CTL_DEL`：删除监控项。

```cpp
epoll_event event{};
event.events = EPOLLIN;          // 关心“可以读取”。
event.data.fd = pipe_read_fd;    // 事件返回时用它识别来源。

if (epoll_ctl(epoll_fd, EPOLL_CTL_ADD, pipe_read_fd, &event) == -1) {
    // 常见错误包括fd无效、重复ADD或目标类型不支持epoll。
}
```

`event.data`是联合体，也可以保存`u64`或用户指针。保存指针时，指针所指对象必须活到所有可能的就绪事件都处理完；删除fd后立即销毁对象，而就绪队列仍保存旧事件，是常见生命周期错误。

### 7.6 epoll_wait等待并取得就绪事件

```cpp
#include <sys/epoll.h>

int epoll_wait(int epoll_fd, epoll_event* events,
               int max_events, int timeout_ms);
```

- `events`：由调用者提供的输出数组。
- `max_events`：数组最多能容纳多少个事件，必须大于0。
- `timeout_ms=-1`：一直等待；`0`：立即返回；正数：最多等待相应毫秒。
- 返回值：大于0表示事件数，0表示超时，-1表示错误。

```cpp
#include <array>
#include <cerrno>

std::array<epoll_event, 16> ready_events{};
int count = epoll_wait(epoll_fd, ready_events.data(),
                       static_cast<int>(ready_events.size()), 1000);
if (count == -1 && errno == EINTR) {
    // 被信号打断，不代表epoll实例损坏；按退出策略决定重试还是结束。
}
```

遍历范围只能是`[0, count)`。数组其余元素不是本次有效事件。

### 7.7 水平触发LT与边沿触发ET的区别

水平触发（level-triggered，LT）是默认模式：只要fd仍处于可读或可写状态，后续`epoll_wait()`还会继续报告。它更容易写对。

边沿触发（edge-triggered，ET）使用`EPOLLET`：重点通知状态从“不就绪”变成“就绪”的边沿。如果收到通知后只读一部分数据，剩余数据可能仍在缓冲区，但没有新的状态边沿，程序可能长期收不到下一次通知。

初学和连接数不高的程序优先LT。只有确认事件循环、非阻塞I/O和完整排空逻辑正确后，再因明确性能证据选择ET。

### 7.8 ET模式配合非阻塞I/O和读取到EAGAIN

ET模式的标准读取规则是：

```text
把fd设为O_NONBLOCK
→ 收到EPOLLIN
→ 循环read
→ read > 0：处理并继续读
→ read == 0：对端关闭
→ read == -1且errno == EINTR：重试
→ read == -1且errno为EAGAIN/EWOULDBLOCK：本轮已经排空，返回事件循环
→ 其他错误：关闭并清理连接
```

非阻塞设置可以使用：

```cpp
#include <fcntl.h>

int flags = fcntl(fd, F_GETFL, 0);
if (flags != -1) {
    // 保留原有状态标志，只附加O_NONBLOCK。
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}
```

ET下也要为写缓冲设计状态机：`write()`只完成一部分时保存剩余数据，真正有待发送内容时才关注`EPOLLOUT`，否则许多始终可写事件会造成忙循环。

### 7.9 EPOLLONESHOT、多线程等待与事件重新激活

`EPOLLONESHOT`使一个监控项报告一次事件后暂时禁用。工作线程处理完毕后，应用必须通过`EPOLL_CTL_MOD`重新激活（rearm）：

```cpp
epoll_event event{};
event.events = EPOLLIN | EPOLLONESHOT;
event.data.fd = client_fd;
epoll_ctl(epoll_fd, EPOLL_CTL_MOD, client_fd, &event);
```

它常用于避免多个工作线程同时处理同一连接，但不会自动保护连接对象中的业务状态。对象所有权、关闭竞争、任务队列和重新激活时机仍要设计清楚。

多个线程可以同时等待同一个epoll fd。ET事件通常只唤醒其中一个等待者以减轻惊群，但应用不能据此推导自己的任务一定只被处理一次；还要正确管理重复事件、错误事件和用户数据生命周期。

### 7.10 epoll资源关闭、事件遗漏和饥饿问题

常见错误包括：

- 忘记非阻塞排空ET fd，导致事件遗漏。
- 忽略`EPOLLERR`和`EPOLLHUP`，连接永远留在集合中。
- 关闭fd后，fd数字被系统复用，而应用的旧事件仍把数字当成原连接。
- 一个连接在单次循环处理过多数据，其他就绪连接长期得不到服务。
- 业务回调耗时过长，事件循环不能及时继续等待。

解决思路是让事件对象具有明确生命周期；错误和挂断也进入统一关闭路径；单连接每轮设置合理处理预算；耗时推理任务交给有限工作队列，并通过eventfd等方式把完成通知送回事件循环。

### 7.11 使用epoll监控pipe读端的API示例

最小流程如下，完整可运行版本见第10.3节：

```cpp
int pipe_fds[2]{};
pipe2(pipe_fds, O_CLOEXEC | O_NONBLOCK);

int epoll_fd = epoll_create1(EPOLL_CLOEXEC);
epoll_event interest{};
interest.events = EPOLLIN;
interest.data.fd = pipe_fds[0];
epoll_ctl(epoll_fd, EPOLL_CTL_ADD, pipe_fds[0], &interest);

// 写端产生数据后，读端变为可读并进入epoll就绪队列。
write(pipe_fds[1], "ready", 5);

epoll_event ready{};
int count = epoll_wait(epoll_fd, &ready, 1, 1000);
```

这个例子同时证明：pipe端点是fd、epoll实例也是fd、`epoll_wait()`返回事件而业务数据仍要用`read()`取得。

## 8 Linux动态库的链接、查找与运行时加载

### 8.1 普通动态库如何链接和加载

使用动态库分为两个阶段。编译链接时，编译器通过头文件知道函数声明，链接器在`libfoo.so`中确认函数存在，并在可执行文件中记录对这个库的依赖；程序启动时，Linux动态加载器再找到`libfoo.so`，将它映射到进程中。动态库代码不会完整复制到可执行文件里。

```bash
g++ main.cpp -I/opt/foo/include -L/opt/foo/lib -lfoo -o app
```

其中`-I`指定头文件目录，`-L`指定链接时的库目录，`-lfoo`表示链接`libfoo.so`。

CMake中的对应写法是：

```cmake
add_executable(app main.cpp)

# 编译时查找动态库提供的头文件。
target_include_directories(app PRIVATE /opt/foo/include)

# 链接时查找并连接libfoo.so。
find_library(FOO_LIBRARY NAMES foo PATHS /opt/foo/lib REQUIRED)
target_link_libraries(app PRIVATE ${FOO_LIBRARY})
```

程序运行时会从`/lib`、`/usr/lib`、部分系统的`/lib64`、`/usr/lib64`，以及`/etc/ld.so.cache`记录的目录中查找动态库。Ubuntu还常见`/lib/aarch64-linux-gnu`、`/usr/lib/aarch64-linux-gnu`等架构目录。

非默认目录可以选择以下一种方法：

```bash
# 临时指定，仅影响本次程序运行。
LD_LIBRARY_PATH=/opt/foo/lib ./app
```

也可以把`/opt/foo/lib`写入`/etc/ld.so.conf.d/foo.conf`，然后执行`sudo ldconfig`登记到系统；如果动态库随程序一起发布，则可以通过CMake设置相对路径：

```cmake
# $ORIGIN表示可执行文件所在目录。
set_target_properties(app PROPERTIES
    INSTALL_RPATH "$ORIGIN/../lib"
)
```

需要特别注意：`-L`和`find_library()`只解决链接阶段的问题，不保证程序运行时也能找到动态库。准确的搜索顺序和例外可查看[动态库运行时搜索规则](https://man7.org/linux/man-pages/man8/ld.so.8.html)。

### 8.2 `dlopen()`和`dlsym()`如何查找函数

`dlopen()`用于程序运行过程中主动加载动态库，`dlsym()`则根据函数在动态库导出符号表中的名字取得函数地址。

这个名字通常由动态库作者定义，并通过头文件、接口文档或插件协议告诉调用者。例如动态库准备导出`foo_run`：

```cpp
// extern "C"禁止C++修改函数名，使导出的符号名称保持为foo_run。
// visibility("default")确保使用隐藏符号策略时，这个函数仍然对外可见。
extern "C"
__attribute__((visibility("default")))
int foo_run(int value)
{
    return value * 2;
}
```

普通Linux编译配置下，全局非`static`函数通常默认可导出，此时不一定需要`visibility`设置。但是函数被声明为`static`、使用`-fvisibility=hidden`后没有单独公开、C++函数没有使用`extern "C"`而发生名称改写，或者链接脚本主动隐藏符号时，`dlsym()`都可能无法按预期名称找到它。

可以直接查看动态库实际导出了什么名字：

```bash
# -D只查看动态符号；--defined-only只显示库自身提供的符号。
nm -D --defined-only libfoo.so
```

如果输出中存在`foo_run`，程序就可以按这个名字查找：

```cpp
#include <dlfcn.h>
#include <cstdio>

using FooRun = int (*)(int); // foo_run函数的参数和返回值类型

int main()
{
    void* handle = dlopen("./libfoo.so", RTLD_NOW | RTLD_LOCAL);
    if (handle == nullptr) {
        // 加载失败后没有有效句柄，不能继续调用dlsym()。
        std::fprintf(stderr, "dlopen failed: %s\n", dlerror());
        return 1;
    }

    dlerror(); // 清除上一次遗留的错误状态
    void* symbol = dlsym(handle, "foo_run");
    const char* error = dlerror();
    if (error != nullptr) {
        // 没有取得函数地址时，先关闭已经加载的动态库再退出。
        std::fprintf(stderr, "dlsym failed: %s\n", error);
        dlclose(handle);
        return 1;
    }

    // 调用方必须保证函数指针类型与库中的真实函数完全一致。
    FooRun foo_run = reinterpret_cast<FooRun>(symbol);
    std::printf("result = %d\n", foo_run(10));

    // 函数指针在dlclose()后失效，因此必须先完成调用再关闭动态库。
    dlclose(handle);
    return 0;
}
```

调用方可使用`g++ main.cpp -ldl -o app`完成编译，运行后应输出`result = 20`。

`dlsym()`不会读取头文件，也不会检查函数参数是否正确，它只是按字符串搜索导出符号。因此函数名称和函数指针类型都应来自动态库公开的接口约定，具体接口行为可查看[`dlsym()`说明](https://man7.org/linux/man-pages/man3/dlsym.3.html)。

### 8.3 动态库的主要注意事项

最常见的问题是链接成功但运行时找不到`.so`，此时应检查运行路径，而不是继续修改头文件目录。其他常见问题包括库与程序的CPU架构不同、头文件和动态库版本不一致、动态库依赖的其他库缺失，以及`dlsym()`使用的名字或函数指针类型错误。

```bash
ldd ./app                    # 检查依赖库是否找到
readelf -d ./app             # 查看动态库依赖和运行路径
file ./app ./libfoo.so       # 检查CPU架构和位数
nm -D -C ./libfoo.so         # 查看动态库导出的函数
```

其中`nm -D`查看的就是`dlsym()`能够搜索的动态符号，参数含义可参考[GNU `nm`说明](https://sourceware.org/binutils/docs/binutils/nm.html)。

## 9 ELF文件格式与动态库排查工具

### 9.1 ELF文件格式的作用和文件类型

ELF（Executable and Linkable Format，可执行与可链接格式）是Linux常用的目标文件格式。它可以表示：

- 可重定位目标文件，例如`.o`；
- 可执行文件；
- 共享对象，例如`.so`，现代位置无关可执行文件也常使用相近类型；
- core dump。

ELF是一个组织机器代码、数据、装载信息、符号和调试信息的容器，不等于某种CPU指令集。文件头会说明目标架构、位数和字节序。

### 9.2 ELF文件头记录的架构与入口信息

```bash
readelf -h ./vision_app
```

重点字段：

- `Class`：ELF32或ELF64。
- `Data`：大小端字节序。
- `Type`：目标文件类型。
- `Machine`：目标CPU架构。
- `Entry point address`：程序入口地址。
- 程序头表和节表的位置、数量。

交叉编译部署失败时，先核对`Machine`和位数，能快速排除把主机库复制到ARM设备等错误。

### 9.3 程序头表与运行时内存段

程序头表（program header table）面向装载器，描述哪些文件区间映射为运行时内存段、权限是什么、动态链接器在哪里等：

```bash
readelf -l ./vision_app
```

常见`LOAD`段分别具有读、写、执行权限；`INTERP`指出动态解释器；`DYNAMIC`定位动态链接信息。装载器按段工作，不是简单地把每个节原样映射一遍。

### 9.4 节表、代码节、数据节和符号表

节（section）主要服务编译、链接和分析：

```bash
readelf -S ./vision_app
```

常见节包括：

- `.text`：机器代码。
- `.rodata`：只读常量。
- `.data`：已初始化可写数据。
- `.bss`：零初始化或未显式初始化的可写数据。
- `.dynsym/.dynstr`：动态符号及字符串。
- `.symtab/.strtab`：更完整的普通符号及字符串，strip后可能不存在。

段是运行时装载视角，节是链接和分析视角；两者不是一一对应。

### 9.5 ELF动态段中的依赖和搜索路径

```bash
readelf -d ./vision_app
```

动态段可看到`NEEDED`、`SONAME`、`RUNPATH/RPATH`以及重定位、符号表相关入口。排查动态库时，`readelf -d`展示ELF自己记录了什么；`ldd`展示当前环境最终解析成什么路径，两者需要结合。

### 9.6 使用ldd检查动态库解析结果

```bash
ldd ./vision_app
```

输出中通常包含依赖名称、解析路径和装载地址。出现`not found`表示当前运行环境无法解析该依赖。还要警惕解析到了“能找到但版本错误”的同名库，因此路径本身也要检查。

不要对来源不可信的可执行文件直接运行`ldd`。在某些实现或特殊ELF情况下，检查过程可能导致目标代码被执行；不可信文件优先用`readelf -d`静态查看依赖。

### 9.7 使用readelf检查ELF头、段、节和动态信息

常用组合：

```bash
readelf -h file         # ELF头：架构、类型、入口
readelf -l file         # 程序头与运行时段
readelf -S file         # 节表
readelf -d file         # 动态段和依赖
readelf -Ws file        # 符号表
```

`readelf`直接解析ELF结构，不依赖程序能够在当前机器上运行，因此适合检查交叉编译产物。GNU Binutils的[`readelf`文档](https://sourceware.org/binutils/docs/binutils/readelf.html)列出了各选项准确含义。

### 9.8 使用nm检查导出符号和未定义符号

```bash
nm -D --defined-only libframe_stats.so
nm -D --undefined-only libframe_stats.so
```

`-D`查看动态符号；常见类型字母中，`T`表示已定义的代码符号，`U`表示未定义、需要由其他对象提供的符号。库内部存在`U`不一定错误，它可能正常依赖libc或另一动态库；必须结合`DT_NEEDED`和最终装载环境判断。

### 9.9 C++符号修饰与符号还原

C++支持重载、命名空间和类成员，链接器符号通常经过名称修饰（name mangling）。使用`-C`可以还原成较易读的形式：

```bash
nm -D -C libframe_stats.so | grep frame_mean
readelf -Ws libframe_stats.so | c++filt
```

如果插件需要稳定地按字符串调用`dlsym()`，通常给入口使用`extern "C"`避免C++名称修饰，并设计清晰的C ABI；这只解决符号名称，不自动解决参数布局和版本兼容。

## 10 Linux启动、IPC、epoll与动态库实验

### 10.1 Linux启动链观察实验

**目的**：不修改系统，找出当前Ubuntu机器的PID 1、默认目标、关键启动链、网络后端和服务配置来源。

**平台与依赖**：Ubuntu 22.04或其他使用systemd的Linux；普通查看命令不需要额外库，部分系统日志可能需要`sudo`。

按顺序执行：

```bash
# 1. 确认第一个用户空间进程和默认启动目标。
ps -p 1 -o pid,comm,args
systemctl get-default

# 2. 查看默认目标递归拉起了哪些单元。
systemctl list-dependencies --all default.target

# 3. 查看本次启动的关键耗时依赖链和内核早期日志。
systemd-analyze critical-chain
journalctl -b -k

# 4. 确认网络配置入口与实际后端。
sudo netplan get
systemctl is-active systemd-networkd NetworkManager

# 5. 任选一个正在运行的服务，追踪其文件、依赖和日志。
systemctl cat ssh.service
systemctl show ssh.service -p FragmentPath -p Wants -p Requires -p Before -p After
journalctl -b -u ssh.service
```

如果机器没有安装SSH，最后一步换成`systemd-journald.service`等实际存在的服务。输入来自当前系统配置，输出是依赖树、配置路径和本次开机日志。

**验收**：能够指出默认目标是什么、某个服务的最终配置来自哪个文件、网络由哪个后端管理，并说明`systemd-analyze blame`为什么不能单独当成严格启动顺序。

### 10.2 pipe父子进程通信实验

**目的**：证明pipe返回的fd可以跨`fork()`继承，并验证“关闭不用的写端”对EOF的重要性。

**输入与输出**：子进程写入固定文本，父进程读取并打印；无需外部输入。

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
        // fork失败时当前进程仍拥有管道两端，必须全部关闭。
        std::perror("fork");
        close(pipe_fds[0]);
        close(pipe_fds[1]);
        return 1;
    }

    if (child_pid == 0) {
        // 子进程只负责写；关闭读端，避免保留无用资源。
        close(pipe_fds[0]);

        constexpr char kMessage[] = "message from child\n";
        std::size_t sent = 0;
        while (sent < sizeof(kMessage) - 1) {
            ssize_t result = write(pipe_fds[1], kMessage + sent,
                                   sizeof(kMessage) - 1 - sent);
            if (result > 0) {
                sent += static_cast<std::size_t>(result);
            } else if (result == -1 && errno == EINTR) {
                // 信号打断时没有完成本轮写入，从原位置重试。
                continue;
            } else {
                close(pipe_fds[1]);
                _exit(2);
            }
        }

        // 关闭最后一个写端后，父进程读完缓冲数据将得到EOF。
        close(pipe_fds[1]);
        _exit(0);
    }

    // 父进程只负责读。若保留自己的写端，read读完数据后不会得到EOF。
    close(pipe_fds[1]);

    std::array<char, 128> buffer{};
    while (true) {
        ssize_t received = read(pipe_fds[0], buffer.data(), buffer.size());
        if (received > 0) {
            std::cout.write(buffer.data(), received);
        } else if (received == 0) {
            // 所有写端已关闭且缓冲区已读空，管道到达EOF。
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
    if (waitpid(child_pid, &child_status, 0) == -1 ||
        !WIFEXITED(child_status) || WEXITSTATUS(child_status) != 0) {
        std::cerr << "child failed\n";
        return 1;
    }
    return 0;
}
```

构建运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic pipe_demo.cpp -o pipe_demo
./pipe_demo
```

预期输出：

```text
message from child
```

**故障注入**：暂时注释父进程的`close(pipe_fds[1])`。父进程能读到文本，但之后会继续等待，因为它自己仍持有一个写端。恢复关闭语句后程序正常结束。

### 10.3 epoll监控pipe文件描述符实验

**目的**：观察“写入pipe → 读端就绪 → `epoll_wait()`返回事件 → `read()`取得数据”的完整路径。

**输入与输出**：程序内部写入固定文本，输出就绪fd和读取内容。依赖Linux的`epoll`和`pipe2`。

```cpp
// epoll_pipe_demo.cpp
#include <array>
#include <cerrno>
#include <cstdio>
#include <fcntl.h>
#include <iostream>
#include <sys/epoll.h>
#include <unistd.h>

// 本Demo手工管理Linux fd；函数只关闭有效fd，避免错误路径重复判断。
void close_if_valid(int fd) {
    if (fd >= 0) {
        close(fd);
    }
}

int main() {
    int pipe_fds[2]{-1, -1};
    // 两端均非阻塞，并且不会泄漏给exec后的新程序。
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

    constexpr char kMessage[] = "pipe is ready\n";
    ssize_t sent = write(pipe_fds[1], kMessage, sizeof(kMessage) - 1);
    if (sent != static_cast<ssize_t>(sizeof(kMessage) - 1)) {
        // 消息很小，本Demo要求一次完整写入；失败则不继续伪造成功结果。
        std::perror("write");
        close_if_valid(epoll_fd);
        close_if_valid(pipe_fds[0]);
        close_if_valid(pipe_fds[1]);
        return 1;
    }

    epoll_event ready{};
    int count = epoll_wait(epoll_fd, &ready, 1, 1000);
    if (count != 1 || ready.data.fd != pipe_fds[0] ||
        (ready.events & EPOLLIN) == 0) {
        std::cerr << "expected readable pipe event, count=" << count << '\n';
        close_if_valid(epoll_fd);
        close_if_valid(pipe_fds[0]);
        close_if_valid(pipe_fds[1]);
        return 1;
    }

    std::cout << "ready fd: " << ready.data.fd << '\n';
    std::array<char, 64> buffer{};
    while (true) {
        ssize_t received = read(pipe_fds[0], buffer.data(), buffer.size());
        if (received > 0) {
            std::cout.write(buffer.data(), received);
        } else if (received == -1 && errno == EINTR) {
            continue;
        } else if (received == -1 &&
                   (errno == EAGAIN || errno == EWOULDBLOCK)) {
            // 非阻塞读到EAGAIN，说明当前pipe数据已经排空。
            break;
        } else {
            std::cerr << "unexpected read result\n";
            close_if_valid(epoll_fd);
            close_if_valid(pipe_fds[0]);
            close_if_valid(pipe_fds[1]);
            return 1;
        }
    }

    // epoll实例和pipe两端由当前进程拥有，结束前逐一释放。
    close_if_valid(epoll_fd);
    close_if_valid(pipe_fds[0]);
    close_if_valid(pipe_fds[1]);
    return 0;
}
```

构建运行：

```bash
g++ -std=c++17 -Wall -Wextra -pedantic epoll_pipe_demo.cpp -o epoll_pipe_demo
./epoll_pipe_demo
```

预期输出包含实际fd数字和`pipe is ready`。执行期间也可以在另一个终端观察`ls -l /proc/<PID>/fd`；如果程序结束太快，可在清理前临时加入等待输入，仅用于观察。

**故障注入**：把超时改为0并把`write()`移到`epoll_wait()`之后，本次等待会返回0，因为等待发生时尚无就绪事件。恢复正确顺序后应返回1。

### 10.4 动态库构建、检查与加载失败实验

**目的**：完成“编译共享库、链接程序、查看ELF依赖、检查导出符号、制造运行时找不到库并修复”的闭环。

目录中创建四个文件：

```cpp
// frame_stats.hpp
#pragma once

#include <cstddef>
#include <cstdint>

// 使用C链接名称，便于nm查看和未来按名称查找；参数仍按本Demo的C++头文件使用。
extern "C" double frame_mean(const std::uint8_t* values, std::size_t count);
```

```cpp
// frame_stats.cpp
#include "frame_stats.hpp"

extern "C" double frame_mean(const std::uint8_t* values, std::size_t count) {
    if (values == nullptr || count == 0) {
        // 空输入没有可计算均值，本Demo约定返回0.0。
        return 0.0;
    }

    std::uint64_t sum = 0;
    for (std::size_t index = 0; index < count; ++index) {
        sum += values[index];
    }
    return static_cast<double>(sum) / static_cast<double>(count);
}
```

```cpp
// main.cpp
#include "frame_stats.hpp"

#include <array>
#include <cstdint>
#include <iostream>

int main() {
    const std::array<std::uint8_t, 4> values{10, 20, 30, 40};
    std::cout << "mean=" << frame_mean(values.data(), values.size()) << '\n';
    return 0;
}
```

```cmake
# CMakeLists.txt
cmake_minimum_required(VERSION 3.16)
project(stage19_dynamic_library LANGUAGES CXX)

add_library(frame_stats SHARED frame_stats.cpp)
target_compile_features(frame_stats PUBLIC cxx_std_17)
target_include_directories(frame_stats PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")

# SOVERSION形成libframe_stats.so.1运行时名称，VERSION是具体库版本。
set_target_properties(frame_stats PROPERTIES
    VERSION 1.0.0
    SOVERSION 1
)

add_executable(vision_app main.cpp)
target_link_libraries(vision_app PRIVATE frame_stats)

# 构建目录中让程序从自身目录寻找随附动态库。
set_target_properties(vision_app PROPERTIES
    BUILD_RPATH "$ORIGIN"
)
```

构建和正常验证：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build -j
./build/vision_app

readelf -d ./build/vision_app | grep -E 'NEEDED|RPATH|RUNPATH'
ldd ./build/vision_app
nm -D -C ./build/libframe_stats.so | grep frame_mean
```

预期程序输出`mean=25`；`readelf`能看到`libframe_stats.so.1`依赖和包含`$ORIGIN`的RUNPATH；`ldd`解析到构建目录中的库；`nm`显示已定义的`frame_mean`。

制造加载失败：

```bash
rm -rf /tmp/stage19-run
mkdir /tmp/stage19-run
cp ./build/vision_app /tmp/stage19-run/
/tmp/stage19-run/vision_app
```

临时目录中没有共享库，因此应出现`libframe_stats.so.1: cannot open shared object file`。修复部署内容：

```bash
cp -a ./build/libframe_stats.so* /tmp/stage19-run/
/tmp/stage19-run/vision_app
ldd /tmp/stage19-run/vision_app
```

**验收**：能够说出头文件在哪个阶段使用、`DT_NEEDED`记录了什么、`$ORIGIN`相对哪个文件展开，以及为什么只复制可执行文件会失败。
