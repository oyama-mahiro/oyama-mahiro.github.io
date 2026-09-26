---
title: '[嵌入式AI-视频工程] PTS、DTS与timebase'
published: 2026-09-24T08:17:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍PTS、DTS与timebase的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-8 PTS、DTS与time_base

编码器输出压缩数据以后，应用还要解决三个问题：怎样确定一张编码图像的边界，怎样把视频、音频等多路数据组织到同一个文件或传输流中，以及怎样让接收端在正确时刻解码和显示这些数据。本阶段沿着压缩数据向外包装的顺序，说明NAL单元、访问单元、基本流、PES、MPEG-TS、MP4、RTP和网络协议之间的关系，最后确定PTS、DTS与`time_base`分别属于哪一层。

## 1 原始媒体、压缩编码、系统封装、实时传输与网络承载的分层

### 1.1 JPEG、H.264、H.265与MPEG-2 Video所属的压缩编码层

压缩编码层负责把原始媒体转换成更少的字节。视频编码器的输入通常是RGB、YUV等原始图像，音频编码器的输入通常是PCM采样；编码器的输出是遵循某种编码语法的压缩数据。

常见编码格式包括：

- JPEG：压缩一张静态图像。连续独立编码多张JPEG图像形成的内容通常称为MJPEG（Motion JPEG）。
- H.264/AVC和H.265/HEVC：面向连续视频，能够使用帧内预测、帧间预测和参考图像压缩时间冗余。
- MPEG-2 Video：MPEG-2标准中的视频编码格式，早期数字电视和DVD中很常见。
- AAC、MP2、Opus：音频编码格式。

阶段2-7已经说明H.264/H.265的预测、变换、量化、NAL头和常见NAL类型。本阶段从编码器形成NAL单元之后继续向上追踪。JPEG拥有自己的标记段和扫描数据语法，不经过NAL层。

### 1.2 MPEG-TS、MP4、AVI与MOV所属的系统封装层

系统封装层接收已经编码完成的媒体数据，加入轨道或流标识、时间关系、索引和多路复用信息。它不重新执行图像预测、变换或量化。

- MPEG传输流（MPEG Transport Stream，MPEG-TS）把多路编码基本流经过PES包装后切成固定188字节的TS packet，适合持续传输和接收端快速重新同步。
- MP4使用轨道、sample、chunk、索引表和时间表组织媒体，适合文件存储、随机访问以及分片传输。
- MOV与MP4同属相近的文件格式体系。
- AVI采用RIFF块结构组织音视频数据，是较早的多媒体容器。

因此，`H.264 + AAC → MPEG-TS`和`H.264 + AAC → MP4`都是常见组合。前半部分说明视频与音频怎样压缩，后半部分说明压缩结果怎样共同保存或传输。

### 1.3 RTP、HTTP、UDP、TCP与IP所属的传输层级

实时传输协议（Real-time Transport Protocol，RTP）为实时媒体增加序列号、RTP时间戳和载荷类型等字段。不同编码需要各自的RTP载荷格式，载荷格式规定一张编码图像或一个NAL过大时怎样分片、过小时怎样聚合，以及接收端怎样恢复边界。

HTTP属于应用层协议。HTTP multipart MJPEG使用MIME分隔边界和每个part的头部连续传送JPEG图像。它依靠HTTP/TCP传输，不使用RTP。

UDP和TCP提供端到端传输能力，IP负责网络寻址和路由。常见组合为：

```text
H.264 NAL → RTP/H.264 → RTP → UDP → IP
MPEG-TS packet → RTP/MP2T → RTP → UDP → IP
JPEG图像 → HTTP multipart → HTTP → TCP → IP
```

协议名称出现在同一条媒体链上，不代表它们处于同一层。每一层只解决自己的边界、寻址、顺序、时间或可靠性问题。

### 1.4 MPEG标准名称、MPEG-2 Video、MPEG-TS与MPG文件的区别

MPEG是制定音视频编码与系统标准的专家组名称，也出现在一系列标准和文件格式的名称中。带有“MPEG”的对象可能属于不同层：

| 名称 | 所属层级 | 主要作用 |
| --- | --- | --- |
| MPEG-1 Video | 视频编码 | 压缩连续图像 |
| MPEG-2 Video | 视频编码 | 压缩连续图像 |
| MPEG-4 Part 2 | 视频编码 | 压缩连续图像 |
| H.264/MPEG-4 AVC | 视频编码 | 压缩连续图像 |
| MPEG-PS | 系统封装 | 面向较可靠介质组织音视频 |
| MPEG-TS | 系统封装 | 面向持续传输复用音视频与节目表 |
| `.mpg`或`.mpeg` | 文件扩展名 | 常见内容为MPEG-PS及MPEG-1/2媒体，实际内容应由探测结果确认 |

MPEG-TS能承载多种编码。常见组合包括`MPEG-2 Video + MP2`、`H.264 + AAC`和`H.265 + AAC`。解复用器读取节目映射表后，才能知道某个PID中承载哪一种编码。

## 2 媒体数据的组成、边界表示、系统包装、分包与复用关系

### 2.1 Access Unit与Elementary Stream的逻辑组成关系

访问单元（Access Unit，AU）可以先理解成一个“编码帧包”：它把解码一张视频图像所需的多个相关NAL归为一组。对于H.264/H.265，一张图像可以划分成多个slice，每个slice位于相应的VCL NAL中；参数集、SEI或AUD等非VCL NAL也可以与该图像存在语法上的归属关系。多个相关NAL因此共同组成一个AU。

这个“编码帧包”只用于理解哪些NAL属于同一张图像。H.264/H.265实际向文件或网络输出时，没有标准的`AU header + AU payload`结构，也没有通用的AU启始码或AU长度字段。线上实际出现的是一个个NAL及其外层包装：

```text
逻辑上：AU 0 = NAL 1 + NAL 2 + NAL 3

Annex B实际字节：
启始码 | NAL 1 | 启始码 | NAL 2 | 启始码 | NAL 3
```

接收端先切出NAL，再把属于同一张编码图像的NAL重新归为一个AU。有AUD NAL时，AUD可以提示新AU开始；没有AUD时，解析器读取NAL类型和VCL NAL中的slice header来判断图像边界。MP4 sample边界、RTP timestamp与marker位等外层信息也可以直接提示AU边界。

**下文每次看到AU，都可以直接读成“组成一张编码图像的那一组NAL”。它在概念上类似一个编码帧packet；实际码流中没有AU packet，也没有AU包头。某些编码器API、MP4 sample或解复用后的packet刚好用一个对象保存一个完整AU，那是外层接口提供的边界。**

基本流（Elementary Stream，ES）是一条只含一种编码媒体的连续数据流：

```text
AU0 → AU3 → AU1 → AU2 → …… → H.264视频基本流
AAC访问单元0 → AAC访问单元1 → …… → AAC音频基本流
```

ES同样描述逻辑组成，没有要求在码流中周期性插入通用“ES头”。它的实际字节范围由容器轨道、TS中的PID、文件边界或API上下文确定。

### 2.2 启始码、长度字段、PES头与TS头的不同作用

向上包装时会发生几种性质不同的操作：

- 启始码和NAL长度字段标识NAL边界。
- 多个NAL按照编码语法组成一张编码图像对应的AU，这是逻辑分组。
- PES头为一段单路基本流增加`stream_id`、PTS和DTS等系统信息。
- TS头为固定188字节的传输包增加PID、连续计数器和载荷起始标志。
- MP4在`moov`或`moof`中建立表，用索引描述`mdat`内sample的位置、大小和时间。
- RTP头增加序列号、RTP时间戳、载荷类型和marker位。

这些操作不能简化成“每上一层就给整帧加一个头”。MPEG-TS使用逐层包头；MP4大量使用旁路索引表；AU和ES还可能只有逻辑边界。

### 2.3 复用器与解复用器处理音视频数据的正向和反向过程

复用（multiplexing，mux）是把多路已经编码的媒体及其时间信息组织成一个容器或传输流。执行该操作的组件称为复用器（muxer）。`mutex`表示线程互斥锁，与媒体封装没有层级关系。

复用器的典型输入是：

```text
视频编码包 + 视频编码参数 + PTS/DTS + 视频time_base
音频编码包 + 音频编码参数 + PTS/DTS + 音频time_base
目标格式参数
```

复用器根据目标格式重新表示边界和时间。例如，MPEG-TS复用器生成PES、TS头、PAT和PMT；MP4复用器生成sample表、轨道时间表、`moov`和`mdat`。

解复用器（demuxer）执行逆向操作。它读取外层结构，选择目标轨道或PID，恢复单路编码包及其时间信息，再交给编码解析器或解码器。解复用只去除外层包装，视频像素要在解码后才能得到。

## 3 H.264与H.265从NAL单元到访问单元和基本流的组织过程

### 3.1 NAL头、VCL数据、参数集与补充信息

网络抽象层单元（Network Abstraction Layer Unit，NAL unit）的头部和常见类型已在阶段2-7第2.3节“编码结果怎样组成NAL单元”中说明。本节只保留向上包装需要的分类：

- VCL NAL承载slice压缩数据，属于编码图像的主体。
- H.264的SPS、PPS以及H.265的VPS、SPS、PPS提供解码配置。
- SEI提供补充增强信息。
- AUD提供访问单元边界提示；码流可以不携带AUD。

启始码不属于NAL header。NAL类型由NAL header中的`nal_unit_type`等字段决定。对于H.264，非IDR slice的NAL类型也不能直接确定该slice属于I、P还是B图像；解析器还要读取slice header。

### 3.2 多个NAL单元组成一张编码图像对应的访问单元

按照第2.1节的“编码帧包”理解，一张编码图像包含多个slice时，解析器最终可以得到下面的NAL分组：

```text
可选AUD
可选SPS/PPS/SEI
slice NAL 1
slice NAL 2
slice NAL 3
```

因此，单个NAL没有固定的一帧语义。一个VCL NAL可能只承载一张图像中的一个slice；SPS或SEI NAL本身也不产生可显示图像。

在Annex B码流中，AUD能够直接提示新AU开始。缺少AUD时，解析器比较前后VCL NAL的slice header字段，判断当前NAL是否属于一张新的编码图像。解码器收到的仍是一串NAL字节；解析器识别出AU边界后，再把完整的一组编码图像数据交给后续解码过程。

### 3.3 连续访问单元按解码顺序形成视频基本流

编码器按照解码依赖输出一组组编码图像数据，也就是一组组AU。存在B帧时，解码器必须先得到B帧所引用的后向参考图像，基本流中的解码顺序便会与显示顺序不同。例如：

```text
显示顺序：I0 B1 B2 P3
解码顺序：I0 P3 B1 B2
```

连续的“编码图像NAL组”（AU）组成H.264/H.265基本流后，数据仍只代表单路视频。基本流可以保存为裸码流，也可以继续进入PES、MP4 sample或RTP载荷格式。

## 4 Annex B启始码与长度前缀表示NAL单元边界

### 4.1 三字节和四字节Annex B启始码

H.264/H.265 Annex B字节流在NAL前使用启始码前缀：

```text
00 00 00 01 | NAL 1
00 00 01    | NAL 2
00 00 01    | NAL 3
```

`00 00 01`和`00 00 00 01`都用于定位NAL边界。编码规范对前导零、零字节和启始码前缀有具体语义，所以不能把“四字节启始码一定表示SPS或一帧开始”当作通用规则。NAL负载在形成实际字节序列时还会插入防竞争字节，避免负载内部自然出现会与启始码混淆的模式。

Annex B适合裸码流、MPEG-TS中的AVC/HEVC基本流以及许多硬件解码接口。解析器通过搜索启始码切出NAL，再根据NAL header和slice语法恢复AU边界。

### 4.2 MP4 sample中的NAL长度前缀

MP4中的H.264/H.265 sample通常把每个NAL写成：

```text
NAL长度 | NAL字节
NAL长度 | NAL字节
```

假设长度字段为4字节，`00 00 00 19`表示紧随其后的NAL占25字节。它不是Annex B启始码。长度字段宽度由AVC或HEVC解码配置记录，解析器必须读取配置，不能始终按4字节处理。

参数集常保存在sample entry关联的解码配置中，随后sample可以只保存图像NAL。具体是否也允许在带内重复参数集，取决于sample entry类型和码流约束。

### 4.3 Annex B与长度前缀转换时发生变化和保持不变的数据

转换的核心操作是更换NAL边界表示：

```text
Annex B：启始码 | NAL | 启始码 | NAL
MP4形式：长度   | NAL | 长度   | NAL
```

NAL header和编码负载通常保持原样，因此这种操作属于码流格式转换或重封装，不执行视频重编码。参数集可能需要从MP4解码配置提取并放回Annex B码流，也可能从带内NAL收集到MP4解码配置中。

只把`mdat`中的字节复制出来并改名为`.h264`会保留长度前缀，许多只接受Annex B的解码器会报告找不到启始码或参数集。FFmpeg的`h264_mp4toannexb`和`hevc_mp4toannexb`位流过滤器用于完成相应转换。[FFmpeg位流过滤器文档](https://ffmpeg.org/ffmpeg-bitstream-filters.html)

## 5 H.264、H.265与MPEG-2 Video进入MPEG-TS的完整封装链

### 5.1 视频基本流进入PES packet的过程

H.264进入MPEG-TS的主链为：

```text
NAL → AU → H.264基本流 → PES → TS packet → MPEG-TS
```

PES（Packetized Elementary Stream，分组基本流）把一段连续的单路基本流字节装入一个可变长度包：

```text
PES packet
├── PES header
└── PES packet data
    └── 一段视频或音频基本流字节
```

一个PES只承载一条ES的数据。视频和音频分别形成各自的PES。PES与AU不存在固定的一一对应要求；常见视频复用策略会让PES从AU边界开始，以便让PES头中的时间戳明确作用于载荷开头的AU。一个PES仍可包含多个AU，大AU也可能跨越PES边界。解析器最终依据编码语法恢复真实AU边界。

### 5.2 PES header中的stream_id、PTS与DTS

PES header以包起始码前缀和`stream_id`开头，并可携带PTS、DTS及其他可选字段。`stream_id`用于区分视频、音频或私有流类别；在MPEG-TS中，更具体的基本流选择主要依靠TS层的PID和PMT。

当PES从一个视频AU边界开始时，PES头中的PTS描述该AU的显示时刻，DTS描述该AU的解码时刻。只有PTS与DTS相同时，可以只编码PTS。发生图像重排时，两者都可能出现。

PTS和DTS属于PES层。后续PES被切成多个TS packet时，时间戳字节只随PES头出现在承载PES起点的TS packet载荷中，不会复制到每个188字节包。

### 5.3 PES切分为188字节TS packet的过程

标准MPEG-TS packet固定为188字节：

```text
4字节TS header
+ 可选adaptation field
+ payload
= 188字节
```

复用器把PES的连续字节依次填入多个TS payload。`payload_unit_start_indicator`在某个TS packet的payload开始处包含PES起点时置位。剩余空间可以由适配字段或填充字节补足。

这一分包过程产生以下关系：

- 一个PES通常跨越多个TS packet。
- 一个AU通常跨越多个TS packet。
- 一个NAL也可能跨越多个TS packet。
- 一个TS packet还可能只承载某个NAL中间的一段字节。

接收端按相同PID和连续计数器顺序拼接payload，恢复PES后才能完整取得其中的基本流字节。ITU-T H.222.0明确规定基本流数据进入PES，PES再进入TS packet。[ITU-T H.222.0](https://www.itu.int/rec/T-REC-H.222.0)

### 5.4 PID、PAT与PMT对视频编码类型和节目组成的描述

TS复用器使用13位PID标识不同类型的TS packet。同一个TS流可以包含一个或多个节目，每个节目又可以包含视频、音频和字幕等多条ES。

节目关联表（Program Association Table，PAT）位于PID `0x0000`，记录节目号到PMT PID的映射。节目映射表（Program Map Table，PMT）记录该节目包含哪些ES、每条ES使用哪个PID、采用什么`stream_type`，以及PCR位于哪个PID。

常见`stream_type`包括：

| `stream_type` | 编码类型 |
| --- | --- |
| `0x02` | MPEG-2 Video |
| `0x0F` | AAC音频（ADTS传输） |
| `0x1B` | H.264/AVC视频 |
| `0x24` | H.265/HEVC视频 |

接收端先读取PAT找到PMT，再读取PMT取得视频PID和编码类型，随后收集对应PID的TS packet并选择正确的解码器。`.ts`扩展名本身无法说明内部使用H.264、H.265还是MPEG-2 Video。

### 5.5 PCR、PTS与DTS在MPEG-TS时间系统中的职责

节目时钟参考（Program Clock Reference，PCR）帮助接收端恢复发送端的系统时钟。PCR位于TS适配字段，通常周期性写入PMT指定的PCR PID。PTS和DTS位于PES头，分别安排具体AU的显示与解码时刻。

三者的关系可以概括为：

```text
PCR：接收端用什么系统时钟前进
DTS：这个AU何时进入解码器
PTS：这个AU何时提交显示或播放
```

PTS/DTS的基础部分使用90 kHz计数。PCR具有27 MHz精度表示，由90 kHz基础部分和扩展部分共同形成。应用读取FFmpeg字段时仍应使用对应`time_base`进行换算，不能只看字段名称推定所有对象都采用`1/90000`。

## 6 H.264与H.265进入MP4的完整封装链

### 6.1 访问单元到MP4 video sample的映射

MP4采用基于sample的媒体模型。对于常见H.264/H.265视频，一个video sample通常对应一个AU，也就是一张编码图像所需的NAL集合：

```text
AU中的多个NAL
→ 改用长度前缀表示NAL边界
→ 一个MP4 video sample
```

sample是容器定义的数据单位。它不要求在`mdat`中每个sample前都放一个通用sample头；sample大小、位置、解码时间和显示时间由MP4元数据表描述。

### 6.2 sample组成chunk并写入mdat的数据布局

多个连续sample可以组成一个chunk。chunk是文件布局与索引单位，它让播放器通过较少的偏移记录定位一组sample：

```text
chunk 0：sample 0、sample 1、sample 2
chunk 1：sample 3、sample 4
```

媒体数据箱（media data box，`mdat`）保存视频、音频等sample的实际字节。不同轨道的chunk可以在文件中交错排列，以便播放器按时间顺序读取音视频，而不必先读完完整视频轨道再读取音频。

### 6.3 moov中的编码配置、sample索引与时间表

电影元数据箱`moov`保存轨道结构和解释`mdat`所需的信息。针对普通非分片MP4，理解以下映射已经足够：

- sample description说明编码类型，并关联AVC或HEVC解码配置。
- sample size表记录每个sample的字节数。
- sample-to-chunk表记录sample怎样组成chunk。
- chunk offset表记录chunk在文件中的字节偏移。
- decoding time-to-sample表记录sample的解码持续时间，由此累加得到DTS。
- composition time-to-sample表记录显示时间相对解码时间的偏移，由此得到PTS。

因此，MP4时间关系主要位于表中：

$$
PTS = DTS + \text{composition offset}
$$

`mdat`只保存sample字节，播放器结合`moov`才能知道从哪里取出第几个sample、怎样切分其中NAL以及何时解码和显示。

### 6.4 分片MP4中moof与mdat的媒体片段结构

普通MP4可以集中保存全文件sample索引；分片MP4（fragmented MP4，fMP4）把媒体划分为连续片段：

```text
初始化部分：ftyp + moov
媒体片段0：moof + mdat
媒体片段1：moof + mdat
媒体片段2：moof + mdat
```

`moov`提供轨道和默认配置，`moof`描述当前片段内sample的持续时间、大小、标志和数据位置，紧随其后的`mdat`保存实际媒体字节。这样可以在完整文件尚未生成时持续输出片段，常用于DASH和使用fMP4媒体片段的HLS。FFmpeg将MOV、MP4和ISOBMFF格式归入同一复用器体系，并支持普通和分片写法。[FFmpeg格式文档](https://ffmpeg.org/ffmpeg-formats.html#MOV_002fMPEG_002d4_002fISOMBFF-muxers)

## 7 JPEG与MJPEG从压缩图像到连续媒体流的包装链

### 7.1 JPEG的标记段、压缩扫描数据与完整图像边界

JPEG编码一张图像后，使用标记（marker）和标记段组织解码参数、元数据与压缩扫描数据。常见顺序为：

```text
SOI
→ APP0/JFIF或APP1/Exif
→ DQT
→ SOF
→ DHT
→ SOS
→ 熵编码扫描数据
→ EOI
```

- SOI（Start of Image，`FF D8`）标记压缩图像开始。
- DQT保存量化表。
- SOF保存图像尺寸、分量和采样等帧参数。
- DHT保存霍夫曼表。
- SOS标记一次扫描开始，后面跟随熵编码数据。
- EOI（End of Image，`FF D9`）标记图像结束。

JPEG的“frame”是JPEG编码语法中的一张图像结构，和H.264的I/P/B帧体系没有对应关系。JPEG不产生NAL、SPS、PPS或H.264 AU。

### 7.2 JFIF和Exif对JPEG交换信息的补充

JPEG编码规范定义压缩图像语法，但应用还需要约定颜色解释、像素密度、缩略图和拍摄元数据等交换信息。

JPEG文件交换格式（JPEG File Interchange Format，JFIF）通常在SOI后使用APP0标记段，记录JFIF标识、版本、像素密度和可选缩略图。Exif通常使用APP1标记段，保存相机型号、拍摄参数、方向和时间等元数据。JFIF 1.02明确规定了SOI、APP0和JPEG图像主体的组织关系。[JFIF 1.02规范](https://www.w3.org/Graphics/JPEG/jfif.pdf)

APP标记段位于JPEG压缩图像内部，属于图像交换格式的一部分。MP4、RTP或HTTP multipart则位于整张JPEG图像之外，承担连续媒体的边界、时间或传输职责。

### 7.3 单张JPEG、JPEG文件序列与MJPEG的关系

单个`.jpg`文件通常保存一张从SOI到EOI的JPEG压缩图像。JPEG文件内部一般没有连续视频所需的帧率、PTS和DTS。

JPEG文件序列通过文件名和外部规则确定顺序：

```text
frame-0001.jpg
frame-0002.jpg
frame-0003.jpg
```

读取程序还必须知道帧率、每张图的采集时间或其他外部时间戳，才能建立视频时间轴。

MJPEG表示连续的独立JPEG压缩图像。它的每一帧通常都能单独解码，帧间没有H.264/H.265那样的参考关系。MJPEG压缩效率通常低于使用帧间预测的视频编码，但单帧随机访问简单，摄像头硬件实现和错误恢复也较直接。

### 7.4 HTTP multipart、AVI、MOV、UVC与私有协议中的MJPEG边界

连续JPEG必须由某种外层规则说明图像边界、顺序和时间：

- HTTP MJPEG使用`multipart/x-mixed-replace`。每张JPEG位于一个MIME part中，boundary分隔相邻part，`Content-Type`和可选`Content-Length`描述当前图像。
- AVI或MOV可以把每张JPEG映射为一个视频chunk或sample，由容器索引和时间表描述边界及播放时间。
- USB视频类（USB Video Class，UVC）摄像头可以输出MJPEG。设备把一张JPEG分成USB传输负载，驱动重组完成后通过V4L2 buffer交给应用。阶段2-3第5.2和5.3节已经说明`DQBUF`取得的buffer及`bytesused`；对MJPEG而言，`bytesused`是本次压缩帧的有效字节数。
- 私有TCP协议常在每张JPEG前加入固定头、长度和时间戳。TCP只提供连续字节流，接收程序依靠应用协议长度字段恢复每张图像边界。

MJPEG描述压缩内容；HTTP multipart、容器、UVC或私有协议描述外层承载。看到“MJPEG流”时，还需要确认其具体外层协议。

### 7.5 JPEG家族编码进入MPEG-TS所需的专用映射规范

MPEG-TS系统层能够承载多种基本流，但接收端必须通过PMT的`stream_type`、描述符和约定知道PES payload采用什么语法。把普通JPEG字节直接放进某个PES，并不会自动形成所有TS解复用器都能识别的标准MJPEG节目。

工程中常见的普通MJPEG外层是AVI、MOV、HTTP multipart、RTP/JPEG或UVC。JPEG 2000、JPEG XS等JPEG家族编码存在各自面向MPEG-TS的标准化映射；私有系统也可以使用private stream和自定义描述符传送普通JPEG。此类流要求发送端与接收端采用同一映射规范。

因此，判断“JPEG能否放进TS”要检查三项：具体JPEG家族编码、PMT如何声明该ES、接收端是否实现对应映射。它与“H.264使用已注册`stream_type 0x1B`进入TS”的普遍兼容程度不同。

## 8 H.264、H.265、JPEG与MPEG-TS进入RTP的不同路径

### 8.1 H.264与H.265 NAL的RTP单包、聚合与分片

RTP packet的长度不固定。H.264 RTP packetizer先根据路径最大传输单元（Path Maximum Transmission Unit，Path MTU）和实际协议头长度，计算一个RTP packet最多能携带多少媒体数据。以MTU为1500字节、20字节IPv4头、8字节UDP头和12字节基本RTP头为例，RTP payload的理论上限为：

```text
1500 - 20 - 8 - 12 = 1460字节
```

RTP扩展头、SRTP、VPN和隧道还会占用空间，工程中常把最大RTP媒体载荷配置为约1200～1400字节，最终值应由实际路径MTU和全部外层头长度计算。packetizer据此选择三种处理方式：

- 一个NAL不超过当前RTP payload上限时，将完整NAL放入一个单NAL RTP packet。
- 多个小NAL需要合并发送时，可以使用STAP-A等聚合结构放入一个RTP packet。
- 一个NAL超过当前RTP payload上限时，H.264使用分片单元A（Fragmentation Unit A，FU-A）把这个NAL的数据拆到多个RTP packet中。

FU-A切分的是一个过大的NAL。每个分片都会增加自己的RTP头，并在RTP payload开头增加2字节FU-A信息：

```text
RTP packet
├── RTP header
└── RTP payload
    ├── FU indicator：1字节
    ├── FU header：1字节
    └── 原NAL的数据片段
```

H.264的FU indicator格式为：

```text
  7   6 5   4 3 2 1 0
+---+-----+-----------+
| F | NRI | Type = 28 |
+---+-----+-----------+
```

- `F`和`NRI`复制自原NAL header。
- `Type=28`表示当前RTP payload采用FU-A格式。

FU header格式为：

```text
  7   6   5   4 3 2 1 0
+---+---+---+-----------+
| S | E | R | 原NAL Type|
+---+---+---+-----------+
```

- `S=1`表示这是原NAL的第一个分片。
- `E=1`表示这是原NAL的最后一个分片。
- `R`是保留位，发送时置0。
- `原NAL Type`保存被切分NAL原来的`nal_unit_type`，例如IDR slice的类型5。

假设一个大NAL被拆成三个RTP packet，发送结果为：

| RTP sequence number | RTP timestamp | FU-A的S | FU-A的E | 含义 |
| ---: | ---: | ---: | ---: | --- |
| 100 | 90000 | 1 | 0 | 该NAL的开始分片 |
| 101 | 90000 | 0 | 0 | 该NAL的中间分片 |
| 102 | 90000 | 0 | 1 | 该NAL的结束分片 |

FU-A头没有“所属NAL编号”字段。接收端看到`S=1`后开始组装一个NAL，按连续的RTP sequence number追加后续分片，看到`E=1`时结束组装；这些分片还应具有同一个RTP timestamp。接收端将FU indicator中的`F`、`NRI`和FU header中的原NAL Type重新组合成原NAL header，再把各片段数据依次连接，恢复完整NAL。序号中断表示中间发生丢包，这个NAL通常无法完整恢复。

FU header中的`E`只表示当前NAL结束。RTP header中的marker位通常表示当前AU，也就是当前编码图像的最后一个RTP packet。一个AU含有多个NAL时，中间NAL最后一个FU-A分片可以出现`E=1、marker=0`；最后一个NAL的最后一个分片才会出现`E=1、marker=1`。

以上FU-A结构属于H.264。H.265同样支持大NAL分片，但使用RFC 7798定义的HEVC分片单元头，字段布局不能照搬H.264 FU-A。[RFC 6184](https://www.rfc-editor.org/rfc/rfc6184)、[RFC 7798](https://www.rfc-editor.org/rfc/rfc7798)

### 8.2 JPEG图像的RTP/JPEG载荷分片与重组

RTP/JPEG从一张完整JPEG压缩图像出发：

```text
JPEG压缩图像
→ 提取或描述RTP/JPEG所需参数
→ 将扫描数据分片
→ RTP/JPEG载荷头 + 图像片段
→ RTP packet
```

一张JPEG大于单个网络包时会跨越多个RTP packet。载荷头中的片段偏移指出当前片段在JPEG图像数据中的位置；RTP sequence number用于发现包顺序和丢失；同一图像的packet使用同一RTP timestamp；marker位标记图像最后一个packet。接收端收齐片段并恢复必要的JPEG头和表后，才能交给JPEG解码器。RTP/JPEG的具体载荷结构由RFC 2435定义。[RFC 2435](https://www.rfc-editor.org/rfc/rfc2435)

### 8.3 MPEG-TS packet作为RTP载荷的传输方式

RTP也可以承载已经生成的MPEG-TS：

```text
H.264/H.265/MPEG-2 Video
→ PES
→ 188字节TS packet
→ RTP的MP2T载荷
→ UDP/IP
```

这种路径中，RTP packet的payload放入一个或多个完整TS packet。RTP层只观察TS packet边界，不直接解析内部H.264 NAL。接收端依次去除RTP、重组TS、重组PES，最后才恢复视频基本流。

因此，抓包中看到RTP不能直接推断其载荷是H.264。还要读取RTP payload type及会话描述，确定它表示H264、H265、JPEG还是MP2T。MPEG音视频及MPEG-TS的RTP承载规则由RFC 2250定义。[RFC 2250](https://www.rfc-editor.org/rfc/rfc2250)

### 8.4 RTP序列号、时间戳与marker位

RTP头中的三个字段容易与编码层概念混淆：

- sequence number每发送一个RTP packet递增，用于排序和发现丢包。它描述网络包顺序。
- RTP timestamp表示该媒体数据的采样时刻。同一视频AU的多个分片通常共享同一timestamp。
- marker位的具体含义由载荷格式规定。视频载荷常用它标识一张编码图像或AU的最后一个RTP packet。

RTP timestamp不表示包实际发送时刻，也不等于接收端到达时间。不同媒体流可以采用不同RTP时钟频率和随机初始值。H.264视频的RTP时钟频率为90 kHz；音频时钟通常与音频采样率相关。

### 8.5 RTP、RTCP、RTSP、UDP与TCP的职责边界

RTP传送实时媒体；RTP控制协议（RTP Control Protocol，RTCP）传送发送者报告、接收者报告和统计信息，并能建立RTP时间戳与墙上时钟之间的映射，帮助多路媒体同步。

实时流协议（Real Time Streaming Protocol，RTSP）通常负责`DESCRIBE`、`SETUP`、`PLAY`和`TEARDOWN`等会话控制。会话描述协议（Session Description Protocol，SDP）说明媒体类型、编码、payload type、时钟频率和参数集等协商信息。实际媒体可以通过RTP/UDP传输，也可以按RTSP interleaved方式复用在TCP连接中。

UDP提供数据报边界和低开销，但不保证送达、顺序或重传。TCP提供有序可靠字节流，但丢包重传会阻塞后续字节。具体采用哪条路径由实时性、网络环境和应用协议决定。

## 9 MPEG-TS、MP4、直接RTP与HTTP MJPEG的封装路径对照

### 9.1 MPEG-TS的PES分包和多路复用模型

MPEG-TS的完整路径为：

```text
编码AU → ES → PES → 188字节TS packet → 多PID交错复用
```

它使用逐包PID、连续计数器、PAT、PMT和PCR支持持续接收、多节目复用及中途加入。时间戳位于PES，系统时钟参考位于TS适配字段。TS既可以保存为`.ts`文件，也可以通过UDP、RTP或其他链路持续发送。

### 9.2 MP4的sample索引和文件存储模型

MP4的完整路径为：

```text
编码AU → sample → chunk → mdat
                    ↘ moov或moof中的索引与时间表
```

MP4通过表关联媒体字节与轨道、大小、偏移和时间，适合随机访问和文件播放。普通MP4通常需要取得`moov`后才能完整解释`mdat`；分片MP4将当前片段元数据放在`moof`中，便于渐进输出。

### 9.3 直接RTP的媒体分片和实时传输模型

直接RTP路径为：

```text
编码AU/NAL → 编码专用RTP载荷格式 → RTP packet → UDP/IP
```

这条路径省去PES和TS层。H.264/H.265 RTP载荷格式直接处理NAL的聚合与分片，RTP头提供网络包序号和媒体时间戳。接收端需要SDP等会话信息确定payload type、编码参数和时钟频率。

### 9.4 HTTP multipart的连续JPEG边界模型

HTTP MJPEG路径为：

```text
JPEG图像 → MIME part → multipart HTTP响应 → TCP/IP
```

每个part通常包含`Content-Type: image/jpeg`，还可以包含`Content-Length`。MIME boundary分隔相邻图像。HTTP/TCP保证字节有序送达，应用仍需解析multipart边界，不能把一次TCP读取当作一张JPEG。

四条路径的核心差异为：

| 路径 | 直接处理的编码单位 | 外层边界方法 | 时间信息位置 |
| --- | --- | --- | --- |
| MPEG-TS | ES的连续字节 | PES与固定188字节TS packet | PES中的PTS/DTS、TS中的PCR |
| MP4 | video sample/AU | sample索引表和chunk布局 | 轨道sample时间表 |
| 直接RTP | NAL、AU或JPEG图像片段 | RTP载荷格式和RTP packet | RTP timestamp |
| HTTP MJPEG | 完整JPEG图像 | MIME boundary和可选长度 | HTTP本身不定义视频PTS，应用或发送节奏提供时间 |

## 10 PTS、DTS与time_base在完整封装链中的产生和保存位置

### 10.1 B帧引起的解码顺序与显示顺序重排

解码时间戳（Decoding Timestamp，DTS）规定编码数据何时送入解码器；显示时间戳（Presentation Timestamp，PTS）规定解码结果何时显示或播放。

以显示顺序`I0 B1 B2 P3`为例，B1和B2需要参考I0和P3。解码器必须先得到P3：

```text
显示顺序：I0  B1  B2  P3
解码顺序：I0  P3  B1  B2
```

封装器按解码顺序写入编码包，并分别记录DTS和PTS。解码器按DTS接收和解码，将结果放入解码图像缓冲区，再按PTS输出。禁用B帧只能减少常见的重排来源；具体PTS、DTS关系仍应读取实际流，不能由文件扩展名推断。

### 10.2 编码访问单元及FFmpeg编码包中的PTS、DTS与duration

原始帧进入编码器时通常已经带有表示采样时刻的PTS。编码器进行B帧决策和输出重排后，为输出编码包提供PTS与DTS。一个编码包在常见视频编码器接口中对应一个AU，但解析器、硬件API或特殊分包策略可能改变这个映射，应用应遵守具体接口契约。

FFmpeg的`AVPacket`用于保存压缩数据及其元数据：

- `pts`表示该包对应内容的显示时间戳。
- `dts`表示解码时间戳。
- `duration`表示该包在当前时间基下持续多少刻度。
- `stream_index`说明它属于哪条流。

`AVPacket`结构只保存整数时间戳，没有在每个字段旁重复保存单位。单位来自该处理阶段约定的`time_base`。把packet交给另一个采用不同时间基的组件前，需要进行rescale。

### 10.3 MPEG-TS的PES时间戳、PCR与90 kHz时间体系

MPEG-TS复用器将视频或音频包的时间戳换算到系统规定的时间表示，并把PTS/DTS写入PES头。PTS/DTS基础计数使用90 kHz时钟：

$$
t_{秒}=\frac{PTS}{90000}
$$

例如PTS为180000时，对应2秒。33位PTS/DTS会按模$2^{33}$回绕，连续运行约26.5小时便会经历一次回绕；长时间流处理必须使用支持回绕的比较逻辑。

PCR提供发送端系统时钟参考。它不能替代每个AU的PTS：PCR让接收端时钟以正确速率前进，PTS再指定媒体事件落在该时钟的哪个时刻。

### 10.4 MP4的轨道timescale、解码时间表与显示时间偏移

MP4为每条轨道定义timescale，即该轨道一秒包含多少时间刻度。timescale为48000时，一个刻度等于$1/48000$秒；timescale为90000时，一个刻度等于$1/90000$秒。MP4没有要求所有视频轨道固定使用90000。

解码时间表记录sample duration。依次累加duration得到各sample的DTS。存在B帧重排时，composition offset记录显示时间相对DTS的差值：

$$
PTS_i=DTS_i+offset_i
$$

所以读取MP4中的时间不能只扫描`mdat`。解复用器需要同时解释轨道timescale、解码时间表和composition offset。

### 10.5 RTP时间戳与PES PTS及MP4 sample时间的区别

RTP timestamp、PES PTS和MP4 sample时间都能表示媒体时间，但它们属于不同协议空间：

- RTP timestamp位于每个RTP头中，使用载荷格式规定的时钟频率，并采用会话内随机初始值。
- PES PTS是MPEG系统层字段，使用90 kHz基础计数。
- MP4 sample时间由轨道timescale和时间表表达。

同一视频时刻在三种格式中的整数值可以完全不同。重封装器要先把源timestamp结合源时间基还原为同一实际时刻，再换算到目标时间基。RTP与绝对墙上时间之间的映射通常由RTCP Sender Report提供，不能把RTP timestamp直接当作Unix时间。

### 10.6 JPEG文件和缺失时间戳输入的外部时间轴来源

单张JPEG文件通常只描述一张压缩图像，不含连续视频PTS。把一组JPEG作为视频输入时，时间轴必须来自外部：

- 固定帧率，例如25 fps时相邻图像间隔40 ms。
- 摄像头或V4L2 buffer携带的采集timestamp。
- 文件名或清单中保存的采集时间。
- 私有协议头中的时间戳。
- RTP/JPEG的RTP timestamp。
- AVI、MOV等容器的sample时间表。

裸H.264/H.265 Annex B文件也经常缺少系统层PTS/DTS。解码器可以按照码流顺序恢复图像依赖，但播放器仍需要用户指定帧率、解析码流中的时序信息或依赖外部采集时间，才能建立可靠播放时间轴。

## 11 time_base换算、timestamp rescale与时间戳错误排查

### 11.1 timestamp与time_base换算为秒的公式

`time_base`是一个有理数，表示一个timestamp刻度等于多少秒。若：

$$
time\_base=\frac{num}{den}
$$

则整数时间戳对应的秒数为：

$$
t_{秒}=timestamp\times\frac{num}{den}
$$

例如：

```text
timestamp = 180000
time_base = 1/90000
t = 180000 × 1/90000 = 2秒
```

帧率和时间基有关联，但不能机械地视为同一个字段。固定25 fps视频可以用`1/25`表示每帧一步，也可以在`1/90000`时间基中让相邻帧相差3600；二者都能表示40 ms间隔。

### 11.2 不同time_base之间的timestamp rescale

时间戳从源时间基转换到目标时间基时，实际时间必须保持不变：

$$
ts_{src}\times tb_{src}=ts_{dst}\times tb_{dst}
$$

因此：

$$
ts_{dst}=ts_{src}\times\frac{tb_{src}}{tb_{dst}}
$$

例如，源时间戳2000使用`1/1000`，目标时间基为`1/90000`：

$$
ts_{dst}=2000\times\frac{1/1000}{1/90000}=180000
$$

两个整数都表示2秒。实际代码应使用FFmpeg提供的`av_rescale_q()`或`av_packet_rescale_ts()`等带有理数和舍入处理的函数，避免先做整数除法导致精度归零，也避免乘法中间结果溢出。

重封装时通常需要同时换算`pts`、`dts`和`duration`。缺失时间戳使用`AV_NOPTS_VALUE`表示，不能把它当普通整数参与换算。

### 11.3 时间基混用、DTS非单调与音画不同步的原因

时间戳问题应沿数据链检查“数值、单位、生成者和使用者”：

1. 编码输入帧的PTS是否来自同一个单调时间轴。
2. 编码器要求的`time_base`与输入PTS单位是否一致。
3. 编码器输出包的PTS/DTS是否按接口约定解释。
4. 写入复用器前是否换算到目标流的时间基。
5. 音频和视频是否换算到各自流时间基，并对应同一个起始时刻。

直接复制timestamp整数而不转换单位，会让时长按时间基比例改变。例如数值1000从`1/1000`误当成`1/90000`后，时间从1秒变成约11.11毫秒。

“non-monotonically increasing dts”表示复用器收到的新包DTS没有严格按目标格式要求前进。常见原因包括：按显示顺序提交包含B帧的编码包、重排后没有生成正确DTS、rescale使用了错误方向、时间戳被截断到同一整数刻度，以及跨段拼接时没有调整新片段起点。

音画不同步常来自两条流使用不同起点或时钟：视频使用采集单调时钟，音频使用从零开始的采样计数；丢帧后视频又按帧编号重新生成时间，而音频继续按真实采样数前进。正确处理需要保留权威采集时间，分别换算到音视频流时间基，并在播放端用共同主时钟调度。仅修改容器声明的帧率无法修复已经错误的PTS。
