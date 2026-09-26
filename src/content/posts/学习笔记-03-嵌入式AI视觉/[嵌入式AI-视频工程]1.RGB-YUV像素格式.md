---
title: '[嵌入式AI-视频工程] RGB-YUV像素格式'
published: 2026-09-24T08:10:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍RGB-YUV像素格式的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-1 RGB/YUV像素格式

RGB和YUV首先是颜色分量的表示方式，像素格式则进一步规定这些分量采用多高的位深、是否进行色度降采样，以及最终按照什么顺序存入内存。工程中拿到一帧图像后，不能只知道它“是YUV”，还必须知道它具体是YUYV、NV12还是YUV420P，否则程序无法确定每个字节的含义，也无法正确计算各平面的地址。

本节只讨论最常见的8位、线性、未压缩像素格式。理解路径为：

```text
颜色分量的含义
→ 色度采样后还剩多少Y、U、V样本
→ packed、planar或semi-planar决定样本怎样排列
→ 像素格式名称确定具体字节顺序
→ 根据宽高计算各格式平面和整帧大小
→ FFmpeg或DRM按照同一布局解释缓冲区
```

## 1 RGB、Y′CbCr颜色表示与像素格式的区别

RGB（Red、Green、Blue）使用红、绿、蓝三个颜色分量共同表示一个像素。RGB888中的三个“8”表示R、G、B各使用8 bit，一个像素共有24 bit，也就是3字节。

视频开发中习惯把另一类格式统称为YUV，但数字视频文件和解码帧中实际保存的通常是Y′CbCr：

- Y′是经过非线性编码后的亮度分量。日常开发中通常简称为Y。
- Cb表示蓝色色差分量，很多接口和资料中简称为U。
- Cr表示红色色差分量，很多接口和资料中简称为V。

YUV原本用于描述模拟信号，Y′CbCr用于描述数字采样值。FFmpeg、V4L2和DRM的许多接口仍沿用`YUV`、`YUYV`、`YUV420P`等工程名称，因此后文也沿用Y、U、V的写法，但要知道缓冲区中保存的是离散的数字样本。

把颜色表示变成可以访问的内存，还需要像素格式补充以下信息：

- 每个分量使用多少bit；
- 色度分量是否降采样；
- 分量是交错存储还是分平面存储；
- 同一像素或像素组内的分量顺序；
- 多字节样本采用什么字节序。

因此，“这是YUV图像”不足以确定内存布局。NV12和YUV420P都是8位YUV 4:2:0，总样本数相同，但前者有一个交错UV平面，后者把U、V分别放在两个平面中。

像素格式也不能完整描述最终颜色。色彩矩阵、有限范围或全范围、色度样本位置等元数据同样会影响YUV到RGB的转换结果。本节先把内存布局讲清楚，这些颜色转换参数不与像素格式布局混在一起。

## 2 4:4:4、4:2:2与4:2:0色度采样方式

人眼通常对亮度细节比对颜色细节更敏感，因此视频系统可以保留较完整的Y样本，同时减少Cb和Cr样本。这种减少色度空间分辨率的过程叫作色度子采样（Chroma Subsampling）。

### 2.1 色度采样数字的实际含义

4:4:4、4:2:2和4:2:0描述的是亮度与色度在水平、垂直方向上的采样关系，不是简单的`Y:U:V`数据量比例。对于宽度为W、高度为H的8位图像，可以先记住其直接结果：

| 采样方式 | Y分辨率 | U分辨率 | V分辨率 | 紧密排列时总位数 |
| --- | ---: | ---: | ---: | ---: |
| 4:4:4 | W×H | W×H | W×H | 24 bit/像素 |
| 4:2:2 | W×H | W/2×H | W/2×H | 16 bit/像素 |
| 4:2:0 | W×H | W/2×H/2 | W/2×H/2 | 12 bit/像素 |

这里的总位数按Y、U、V都是8位样本计算。例如4:2:0平均每像素只有12 bit，也就是1.5字节；“平均1.5字节”不表示单个像素可以只占半个字节，而是一个2×2像素块共同使用4个Y样本、1个U样本和1个V样本：

```text
4个Y：4 × 1字节 = 4字节
1个U：1 × 1字节 = 1字节
1个V：1 × 1字节 = 1字节
合计：4个像素使用6字节，平均每像素1.5字节
```

### 2.2 4:2:2与4:2:0的像素共享关系

4:2:2只在水平方向降低色度分辨率。相邻两个像素各有自己的Y，但共享一组U、V：

```text
像素0：Y0 ─┐
            ├─ 共用 U0、V0
像素1：Y1 ─┘
```

因此两个像素需要`Y0、Y1、U0、V0`四个8位样本，共4字节。

4:2:0同时降低水平和垂直方向的色度分辨率。常见的入门模型是一个2×2亮度块共享一组U、V：

```text
Y00  Y01 ─┐
Y10  Y11 ─┴─ 共用 U0、V0
```

四个亮度样本加一组色度样本，共6字节。实际标准还会规定色度样本相对于亮度像素位于左侧、居中或其他位置；这叫色度位置（chroma location或chroma siting）。它会影响高质量缩放和颜色转换，但不改变本节讨论的平面数量与理论样本数。

还要区分两件事：4:2:0只说明“采多少”，没有说明“怎样存”。NV12、NV21和YUV420P都是4:2:0，但内存排列不同。

## 3 packed、planar与semi-planar内存组织方式

色度采样确定一帧有多少样本，内存组织方式则确定这些样本按什么关系放入缓冲区。常见术语是packed、planar和semi-planar。

### 3.1 packed格式的像素与分量交错存储

packed在这里表示交错存储：不同颜色分量按固定顺序混合在同一个格式平面中。读取程序通常以一个像素或一个共享色度的像素组为单位前进。

RGB888每个像素都有完整的R、G、B：

```text
地址递增方向 →
R0 G0 B0 | R1 G1 B1 | R2 G2 B2 | ...
```

YUYV虽然也是packed格式，但4:2:2使它必须以两个像素为一组：

```text
地址递增方向 →
Y0 U0 Y1 V0 | Y2 U2 Y3 V2 | ...
```

这里不存在“像素0单独占`Y0 U0`、像素1单独占`Y1 V0`”的含义。第一组四字节必须整体解释：Y0属于像素0，Y1属于像素1，U0和V0由两个像素共享。若程序错误地以两个字节为一个完整YUV像素，得到的颜色关系就会错误。

### 3.2 planar格式的独立分量平面

planar表示平面存储：每个格式平面只保存一种颜色分量。以YUV420P为例，先保存全部Y，再保存降采样后的U，最后保存降采样后的V：

```text
Y平面 | U平面 | V平面
```

对于4×2图像，紧密排列时的样本是：

```text
Y平面，4×2：
Y00 Y01 Y02 Y03
Y10 Y11 Y12 Y13

U平面，2×1：
U0  U1

V平面，2×1：
V0  V1
```

如果三个平面连续存放，字节序列就是：

```text
[Y00 Y01 Y02 Y03 Y10 Y11 Y12 Y13] [U0 U1] [V0 V1]
```

常见的I420使用Y、U、V平面顺序；YV12使用Y、V、U顺序。因此只说“YUV420 planar”仍可能不够，具体格式名称决定U、V谁在前面。FFmpeg中的`AV_PIX_FMT_YUV420P`使用Y、U、V三个格式平面。

### 3.3 semi-planar格式的亮度平面与交错色度平面

semi-planar表示半平面存储。Y仍单独形成一个平面，但U、V不再各自形成平面，而是在第二个平面内交错排列。

NV12的4×2布局是：

```text
Y平面，4×2：
Y00 Y01 Y02 Y03
Y10 Y11 Y12 Y13

UV平面，4×1字节：
U0 V0 U1 V1
```

NV21的Y平面不变，只交换第二平面中U、V的顺序：

```text
VU平面，4×1字节：
V0 U0 V1 U1
```

所以NV12和NV21的平面数、平面大小和总帧大小完全相同，区别只在第二平面的分量顺序。将NV12当成NV21不会越界，却会把Cb和Cr互换，画面通常明显偏紫或偏绿。

“semi-planar”是工程中常用的分类名称。FFmpeg源码注释把`AV_PIX_FMT_NV12`描述为具有Y平面和交错UV平面的planar YUV 4:2:0；这与把NV12称为semi-planar并不矛盾，关键应看清它实际有一个Y平面和一个交错UV平面，而不是纠结分类词。FFmpeg对这些格式的正式定义可查阅[`libavutil/pixfmt.h`](https://ffmpeg.org/doxygen/trunk/pixfmt_8h_source.html)。

### 3.4 格式平面、内存分配次数与缓冲对象的区别

格式平面描述颜色分量怎样分组，不等于内存分配次数，也不等于文件描述符数量。

以NV12为例，它有Y和UV两个格式平面，但可以有不同的内存承载方式：

```text
方式一：一个缓冲对象
基地址 + 0       → Y平面
基地址 + y_offset → UV平面

方式二：两个缓冲对象
缓冲对象0 → Y平面
缓冲对象1 → UV平面
```

YUV420P有三个格式平面，也可以把三个平面连续放在一次分配的大缓冲区中。反过来，一个缓冲对象还可能包含对齐填充或硬件压缩使用的附加数据。因此下面几个数量不能互相替代：

- 颜色分量数量；
- 像素格式定义的格式平面数量；
- 实际分配的内存缓冲对象数量；
- 用于引用缓冲对象的handle或文件描述符数量。

Linux内核的像素缓冲区共享文档也明确区分image、plane和memory buffer，并指出一个内存缓冲区可以包含一个或多个平面。[Linux内核：Exchanging pixel buffers](https://docs.kernel.org/userspace-api/dma-buf-alloc-exchange.html)

## 4 常见RGB与YUV像素格式的内存布局

### 4.1 RGB888与BGR888的字节顺序

在本节采用的8位packed定义中，RGB888和BGR888都使用3字节表示一个像素：

```text
RGB888：R0 G0 B0 | R1 G1 B1 | ...
BGR888：B0 G0 R0 | B1 G1 R1 | ...
```

二者的帧大小相同，但红、蓝字节位置相反。如果摄像头、图像库和推理模型对通道顺序的约定不一致，图像仍能显示且形状完全正常，只是红色和蓝色互换。预处理代码中的RGB/BGR转换属于真实的数据重排，不能只修改格式名称。

需要注意，某些带字母和数字的硬件格式名称按照32位数值的高低位描述分量，而CPU查看内存时看到的是逐字节顺序；在涉及DRM的XRGB8888等32位格式时，应以对应API的FourCC定义和字节序规则为准，不能把名称中的字母顺序直接当成内存地址顺序。

### 4.2 YUYV与UYVY的4:2:2交错布局

YUYV和UYVY都是8位、packed、4:2:2格式。每两个水平相邻像素固定占4字节：

```text
YUYV：Y0 U0 Y1 V0 | Y2 U2 Y3 V2 | ...
UYVY：U0 Y0 V0 Y1 | U2 Y2 V2 Y3 | ...
```

两者都平均每像素2字节，差别是Y与色度字节的位置。解析YUYV时，程序每次读4字节：先取得两个亮度，再把同一组U、V用于两个输出像素。UYVY执行相同过程，但索引位置不同。

4:2:2需要水平方向按两个像素成组处理，因此通常要求有效宽度为偶数。对奇数宽度直接套用`2 × W × H`，既无法形成最后一个完整像素组，也可能不符合生产者接口的尺寸约束。

### 4.3 NV12与NV21的4:2:0半平面布局

NV12和NV21都由两个格式平面组成：

```text
NV12：Y平面 + UV交错平面
NV21：Y平面 + VU交错平面
```

对于宽W、高H且W、H均为偶数的8位图像：

```text
Y平面：W × H个字节
色度平面：W × H/2个字节
总大小：W × H × 3/2个字节
```

第二平面的逻辑色度分辨率是`W/2 × H/2`，但每个位置同时有U和V两个字节，所以该平面每行仍有W个有效字节，高度为H/2。这个细节可以避免把UV平面错误算成`W/2 × H/2`字节而漏掉一半数据。

NV12常见于硬件解码、摄像头和显示链路，因为亮度与色度区域分开，UV又共同位于一个平面，硬件只需描述两个格式平面。它是否真的能被某个解码器输出或被某个DRM显示平面直接扫描，仍需查询两端支持的格式和modifier，不能仅凭“硬件通常支持NV12”作假设。

### 4.4 YUV420P的4:2:0三平面布局

YUV420P与NV12拥有相同数量的Y、U、V样本，但把U、V分别存储：

```text
Y平面：W × H
U平面：W/2 × H/2
V平面：W/2 × H/2
```

三个平面的紧密排列总大小仍是：

```text
W×H + W×H/4 + W×H/4 = W×H×3/2字节
```

所以文件大小相同不能证明格式相同。一个1920×1080的NV12文件与一个同尺寸YUV420P文件都是3,110,400字节；如果用错误格式读取，程序不会因为文件大小发现问题，但会从错误的偏移和顺序取得色度数据。

## 5 像素格式的帧大小与平面大小计算

### 5.1 紧密排列时的平均每像素字节数

在8位样本、线性布局、没有行尾填充且尺寸满足采样要求时，常见格式可以按下式计算：

| 像素格式 | 每像素平均字节数 | 理论帧大小 |
| --- | ---: | ---: |
| RGB888、BGR888 | 3 | `W × H × 3` |
| YUYV、UYVY | 2 | `W × H × 2` |
| NV12、NV21 | 1.5 | `W × H × 3/2` |
| YUV420P | 1.5 | `W × H × 3/2` |

这里的“每像素平均字节数”适合计算整帧，不一定适合定位任意单个像素。例如NV12中的一个像素没有独立完整的Y、U、V三元组，必须根据Y平面坐标和共享色度坐标分别寻址。

### 5.2 1920×1080图像的格式平面与帧大小计算

1920×1080共有：

```text
1920 × 1080 = 2,073,600个亮度像素
```

RGB888或BGR888：

```text
2,073,600 × 3 = 6,220,800字节
约为5.93 MiB
```

YUYV或UYVY：

```text
2,073,600 × 2 = 4,147,200字节
约为3.96 MiB
```

NV12或NV21：

```text
Y平面  = 1920 × 1080 = 2,073,600字节
UV平面 = 1920 × 540  = 1,036,800字节
总大小 = 3,110,400字节，约2.97 MiB
```

YUV420P：

```text
Y平面 = 1920 × 1080 = 2,073,600字节
U平面 = 960 × 540   =   518,400字节
V平面 = 960 × 540   =   518,400字节
总大小 = 3,110,400字节，约2.97 MiB
```

MiB使用`1 MiB = 1024 × 1024字节`计算，不要把它与十进制MB混用。

### 5.3 理论数据量与实际缓冲区大小的区别

上面的结果是有效像素紧密排列时的理论数据量。真实缓冲区还可能包含：

- 每行末尾的对齐填充；
- 平面起始地址之间的间隔；
- 分配高度向上对齐产生的额外行；
- tiled布局或压缩modifier要求的附加区域；
- 高位深格式带来的更大样本容器。

因此，不能看到NV12就无条件执行一次`memcpy(width * height * 3 / 2)`。若源平面的stride大于有效行字节数，正确做法通常是逐平面、逐行复制有效字节；若目标也要求特定stride，则还要分别使用源和目标的行跨度。本节先区分理论有效数据量，具体地址公式和ROI放到阶段2-2讲解。

## 6 FFmpeg解码帧中的像素格式与格式平面

FFmpeg是一套音视频处理工具和开发库。解码器通常把解码结果交给`AVFrame`结构；对视频帧来说，`format`说明像素格式，`data[]`提供图片平面指针，`linesize[]`描述相邻两行之间的字节跨度。FFmpeg官方的[`AVFrame`文档](https://www.ffmpeg.org/doxygen/trunk/structAVFrame.html)明确说明了这些字段的含义。

### 6.1 AVFrame的format、data与linesize之间的关系

对于一个软件视频帧，可以先建立下面的关系：

```text
frame->format
→ 决定每个data[i]代表哪个格式平面

frame->data[i]
→ 第i个格式平面的首行地址

frame->linesize[i]
→ 从该平面当前行起点移动到下一行起点的字节数
```

以常见的正向存储为例，第i个平面第y行的地址是：

```text
frame->data[i] + y × frame->linesize[i]
```

不能先假设`data[1] = data[0] + width × height`，因为FFmpeg分配器可能给每行添加对齐填充，各平面也不一定来自同一次内存分配。`linesize`甚至可以是负数，用来表示图像行按反方向存放；因此它不是“图像宽度”的别名。

FFmpeg还要求当前格式不需要的`data[]`指针为空。程序应先读取`format`，再按对应格式解释有效指针，而不是遍历所有非空指针猜测格式。

### 6.2 packed、planar与semi-planar格式在AVFrame中的表示

对本节涉及的常见软件帧，典型对应关系如下：

| `AVFrame::format` | `data[]`中的格式平面 | `linesize[]`含义 |
| --- | --- | --- |
| `AV_PIX_FMT_RGB24` | `data[0]`为RGB交错数据 | RGB行跨度 |
| `AV_PIX_FMT_BGR24` | `data[0]`为BGR交错数据 | BGR行跨度 |
| `AV_PIX_FMT_YUYV422` | `data[0]`为YUYV交错数据 | packed 4:2:2行跨度 |
| `AV_PIX_FMT_UYVY422` | `data[0]`为UYVY交错数据 | packed 4:2:2行跨度 |
| `AV_PIX_FMT_NV12` | `data[0]`为Y，`data[1]`为UV | Y与UV各自的行跨度 |
| `AV_PIX_FMT_NV21` | `data[0]`为Y，`data[1]`为VU | Y与VU各自的行跨度 |
| `AV_PIX_FMT_YUV420P` | `data[0]`为Y，`data[1]`为U，`data[2]`为V | 三个平面各自的行跨度 |

使用NV12时，Y平面处理H行，UV平面只处理H/2行；每行有效数据通常都是W字节。使用YUV420P时，Y平面处理H行、每行W个有效字节，U和V平面各处理H/2行、每行W/2个有效字节。实际移动到下一行仍以各自的`linesize[i]`为准。

### 6.3 软件帧与硬件解码帧的内存访问边界

软件像素格式表示CPU可按对应布局解释的像素。硬件加速解码得到的`AVFrame`则可能保存VAAPI、CUDA、VideoToolbox或DRM PRIME等硬件表面引用，此时`frame->format`可能是硬件像素格式，`data[]`也不再是普通的Y、UV像素地址。

例如FFmpeg的`AV_PIX_FMT_DRM_PRIME`帧使用`AVDRMFrameDescriptor`描述DRM对象、格式层和平面，而不是让程序把`data[0]`直接当作Y平面遍历。若确实需要CPU读取，通常要根据硬件类型进行映射，或使用`av_hwframe_transfer_data()`传输到支持的软件格式；该函数的输入、输出和失败返回规则见FFmpeg官方[`hwcontext.h`](https://www.ffmpeg.org/doxygen/trunk/hwcontext_8h_source.html)。

因此排查FFmpeg解码帧时，正确顺序是：

```text
先查看frame->format
→ 判断它是软件像素格式还是硬件表面格式
→ 软件帧按data[]和linesize[]访问
→ 硬件帧按对应硬件上下文映射、传输或导出
```

## 7 DRM framebuffer中的像素格式与格式平面

DRM（Direct Rendering Manager，直接渲染管理器）是Linux图形子系统的核心框架；KMS（Kernel Mode Setting，内核模式设置）负责显示模式、CRTC、显示平面和连接器等显示资源。DRM framebuffer不是一块内存本身，而是把宽高、像素格式以及底层缓冲对象的逐平面元数据登记成一个可供KMS显示的对象。

### 7.1 DRM FourCC像素格式的作用

FourCC（Four Character Code，四字符代码）是用四个字符标识数据格式的编码方式。DRM使用`DRM_FORMAT_*`常量说明framebuffer像素格式，例如`DRM_FORMAT_NV12`。

FourCC负责说明颜色通道、位深、通道关系和格式平面关系。以NV12为例，它说明：

- 第一个格式平面保存8位Y样本；
- 第二个格式平面保存交错UV样本；
- U、V在水平和垂直方向都相对Y进行2倍降采样。

但现代硬件中，FourCC通常还要与format modifier共同解释。modifier描述线性、分块（tiled）或压缩等更底层的内存布局。相同FourCC并不保证CPU看到的物理字节一定按普通线性顺序排列；生产者和消费者必须对format与modifier组合达成一致。Linux内核的[像素缓冲区交换文档](https://docs.kernel.org/userspace-api/dma-buf-alloc-exchange.html)对此给出了完整边界。

### 7.2 framebuffer的handle、pitch与offset

用户空间通过`DRM_IOCTL_MODE_ADDFB2`或libdrm的对应封装登记多平面framebuffer时，核心元数据可概括为：

```text
width、height       → 图像逻辑尺寸
pixel_format        → DRM FourCC格式
handles[i]          → 第i个格式平面依赖的GEM缓冲对象句柄
pitches[i]          → 第i个格式平面的行跨度，单位为字节
offsets[i]          → 第i个格式平面相对缓冲对象起点的字节偏移
modifier[i]         → 底层布局描述
```

GEM（Graphics Execution Manager）是DRM使用的图形缓冲对象管理框架。GEM handle只是当前DRM文件上下文引用缓冲对象的整数编号，不是CPU指针，也不是像素格式。

一个线性NV12 framebuffer可以让两个格式平面引用同一个GEM handle，再用不同offset区分：

```text
handles[0] = buffer_handle
pitches[0] = y_pitch
offsets[0] = 0

handles[1] = buffer_handle
pitches[1] = uv_pitch
offsets[1] = uv_offset
```

也可以让Y和UV来自两个不同的缓冲对象，此时`handles[0]`与`handles[1]`不同。Linux DRM UAPI明确允许同一handle用于多个格式平面，并规定pitch和offset按FourCC定义的平面顺序填写，参见[`drm_mode_fb_cmd2`](https://docs.kernel.org/next/gpu/drm-uapi.html#c.drm_mode_fb_cmd2)。

创建framebuffer只是把这些关系登记给DRM。驱动还会检查目标显示硬件是否支持该FourCC、modifier、pitch、offset和尺寸组合；结构填写完整不代表硬件一定能够扫描该缓冲区。

### 7.3 像素格式平面与DRM显示平面的区别

“plane”在DRM上下文中有两个容易混淆的含义。

像素格式平面是图像数据的组成部分：

```text
NV12 framebuffer
├─ 格式平面0：Y
└─ 格式平面1：UV
```

DRM显示平面则是KMS中的硬件显示层，例如primary plane、overlay plane和cursor plane。显示平面接收一个framebuffer，并把它送往CRTC参与合成和扫描输出：

```text
一个DRM overlay plane（显示平面）
→ 读取一个NV12 framebuffer
→ framebuffer内部包含Y、UV两个格式平面
```

因此不能因为NV12有两个格式平面，就说它需要两个DRM overlay plane。一个支持NV12的overlay plane可以读取整个NV12 framebuffer。反过来，即使系统有多个overlay plane，每个plane能接受的FourCC和modifier组合也可能不同，应用应查询目标plane的支持列表。

FFmpeg硬件解码到DRM显示时，这些对象可以串成下面的关系：

```text
压缩码流
→ FFmpeg解码器产生软件AVFrame或硬件AVFrame
→ 确认实际像素格式、modifier及逐平面元数据
→ 必要时转换格式，或通过DMA-BUF共享底层缓冲区
→ 导入为DRM GEM handle
→ 用FourCC、handle、pitch和offset创建framebuffer
→ 把framebuffer交给支持该格式的DRM显示平面
```

DMA-BUF（Direct Memory Access Buffer）负责跨设备、驱动或进程共享缓冲对象，但DMA-BUF文件描述符本身不携带图像宽高、NV12格式、pitch或offset。这些元数据仍需由接口另外传递；DMA-BUF的对象关系和同步问题将在阶段2-4继续展开。

## 8 像素格式混用导致的颜色异常及排查方法

像素格式错误通常不会立即导致程序崩溃，因为多种格式可能拥有相同帧大小。更常见的结果是图像尺寸看似正确，但颜色或行位置异常。

RGB888与BGR888混用时，G分量位置不变，R与B互换，所以红色物体会变蓝，蓝色物体会变红。应检查生产者输出格式、图像库约定和模型输入通道顺序，不能仅凭变量名判断。

NV12与NV21混用时，Y平面完全相同，所以亮度轮廓正常；UV与VU顺序相反，使颜色整体偏紫、偏绿或肤色明显错误。此时应检查第二平面前两个字节的含义及转换函数的输入格式。

YUYV与UYVY混用时，Y与色度所在字节位置都发生变化，亮度和颜色通常同时异常。排查时应按4字节为一组打印原始数据，再根据生产者文档验证到底是`Y0 U0 Y1 V0`还是`U0 Y0 V0 Y1`。

如果颜色关系基本正确，但画面从某一行开始倾斜、撕裂或每行逐渐错位，问题更可能是把stride误当成有效宽度；如果图像整体偏灰、偏黑或对比度不对，还要检查色彩范围和颜色矩阵。可以按下面的顺序缩小范围：

```text
1. 确认宽、高、位深和软件/硬件帧类型
2. 确认具体像素格式，而不是只确认“RGB”或“YUV”
3. 画出一个像素组或2×2块的分量顺序
4. 确认各平面指针、pitch/linesize和offset
5. 确认format modifier以及生产者和消费者是否都支持
6. 布局正确后，再检查色彩范围、矩阵和色度位置
```

## 9 使用FFmpeg检查4×2原始帧的内存布局

这个微型实验只验证一件事：同一个4×2图像转换成不同像素格式后，文件大小和平面边界怎样变化。它不需要DRM设备，也不实现解码或显示程序。

实验依赖FFmpeg命令行工具、`wc`和`xxd`，适用于Linux。`testsrc2`是FFmpeg提供的测试图生成器；`rawvideo`表示输出文件只有逐帧像素数据，没有文件头，也不会在文件内部记录宽、高和像素格式。后续重新读取这些文件时，必须由调用者另行提供这些元数据。

下面四条命令分别生成一帧RGB24、YUYV422、NV12和YUV420P原始数据。`-frames:v 1`限制只输出一帧，`-pix_fmt`指定输出像素格式，`-f rawvideo`指定无文件头的原始视频格式：

```bash
mkdir -p pixel-format-lab
cd pixel-format-lab

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=4x2:rate=1" \
  -frames:v 1 -threads:v 1 -c:v rawvideo -pix_fmt rgb24 -f rawvideo rgb24.raw

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=4x2:rate=1" \
  -frames:v 1 -threads:v 1 -c:v rawvideo -pix_fmt yuyv422 -f rawvideo yuyv422.raw

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=4x2:rate=1" \
  -frames:v 1 -threads:v 1 -c:v rawvideo -pix_fmt nv12 -f rawvideo nv12.raw

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=4x2:rate=1" \
  -frames:v 1 -threads:v 1 -c:v rawvideo -pix_fmt yuv420p -f rawvideo yuv420p.raw
```

接着查看文件大小：

```bash
wc -c rgb24.raw yuyv422.raw nv12.raw yuv420p.raw
```

4×2共有8个像素，预期大小为：

```text
rgb24.raw    8 × 3   = 24字节
yuyv422.raw  8 × 2   = 16字节
nv12.raw     8 × 1.5 = 12字节
yuv420p.raw  8 × 1.5 = 12字节
```

最后逐字节查看内容：

```bash
xxd -g 1 rgb24.raw
xxd -g 1 yuyv422.raw
xxd -g 1 nv12.raw
xxd -g 1 yuv420p.raw
```

十六进制数值由测试图颜色及FFmpeg采用的颜色转换参数决定，本实验不要求背诵这些值。应观察的是字节数量和边界：

```text
rgb24.raw：
偏移0～23全部是RGB交错像素，每3字节组成一个像素

yuyv422.raw：
偏移0～15全部是YUYV交错数据，每4字节组成两个像素

nv12.raw：
偏移0～7  是8字节Y平面
偏移8～11 是4字节UV交错平面

yuv420p.raw：
偏移0～7  是8字节Y平面
偏移8～9  是2字节U平面
偏移10～11是2字节V平面
```

NV12与YUV420P文件同为12字节，但从偏移8开始，一个按照`U0 V0 U1 V1`解释，另一个按照`U0 U1 | V0 V1`解释。这正说明了为什么总大小只能验证采样数量，不能替代像素格式和内存布局信息。
