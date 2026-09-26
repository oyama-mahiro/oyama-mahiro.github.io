---
title: '[嵌入式AI-视频工程] FFmpeg数据链'
published: 2026-09-24T08:18:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍FFmpeg数据链的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段 2-9：FFmpeg 核心对象，以及编解码数据链

这一节先建立 FFmpeg 的对象地图，再按程序真正执行的时间顺序讲解。整条链分成两大阶段：

1. 初始化阶段：创建对象、复制参数、打开解码器和编码器、写容器头。
2. 循环阶段：读取压缩包、解码成帧、转换帧、重新编码、写入输出文件。

这样阅读时，每个对象都会出现在它第一次参与工作的地方，不需要在多个孤立的对象说明之间来回跳转。

---

## 1. FFmpeg 的库、主要对象和责任

### 1.1 常用库分别负责什么

FFmpeg 的功能分散在多个库中。一个转码程序通常同时使用其中几个：

| 库 | 主要责任 | 本节涉及的典型 API |
|---|---|---|
| `libavformat` | 识别封装格式、解复用、复用、文件或网络 I/O | `avformat_open_input()`、`av_read_frame()`、`av_interleaved_write_frame()` |
| `libavcodec` | 音视频编解码、管理压缩包与原始帧 | `avcodec_send_packet()`、`avcodec_receive_frame()`、`avcodec_send_frame()`、`avcodec_receive_packet()` |
| `libavutil` | 时间基、错误码、像素格式、内存和通用工具 | `av_rescale_q()`、`av_packet_rescale_ts()`、`av_strerror()` |
| `libswscale` | 视频像素格式转换和图像缩放 | `sws_getCachedContext()`、`sws_scale()` |
| `libavfilter` | 由多个滤镜组成复杂处理链 | 本节 Demo 不使用，后续需要裁剪、叠加、硬件帧处理时再引入 |
| `libswresample` | 音频采样格式、采样率和声道布局转换 | 本节只处理视频，因此暂不进入代码 |

### 1.2 主要对象和责任

FFmpeg 的公开接口以 C 结构体为主。它们在工程里承担着类似“类”的职责。

| 对象 | 所属层 | 责任 | 主要依赖 |
|---|---|---|---|
| `AVFormatContext` | 封装层 | 表示一个输入或输出媒体容器，持有流列表和 I/O 状态 | 输入端由 URL 创建；输出端依赖目标文件名或格式名 |
| `AVStream` | 封装层 | 表示容器里的一条音频、视频或字幕流，保存时间基和索引 | 隶属于 `AVFormatContext` |
| `AVCodecParameters` | 参数交接层 | 保存容器记录的编解码参数，如 codec id、宽高、extradata | 隶属于 `AVStream` |
| `AVCodec` | 编解码实现 | 描述某一种具体解码器或编码器实现 | 依赖 codec id 或编码器名称 |
| `AVCodecContext` | 编解码状态 | 保存编解码参数、内部缓存和运行状态 | 创建时依赖 `AVCodec`；打开前需要填入参数 |
| `AVPacket` | 压缩数据层 | 承载压缩后的数据以及 PTS、DTS、流索引等元数据 | 解复用器输出；解码器输入；编码器输出；复用器输入 |
| `AVFrame` | 原始数据层 | 承载解码后的图像或送入编码器的原始图像 | 解码器输出；转换器输入输出；编码器输入 |
| `SwsContext` | 图像转换层 | 保存缩放、像素格式转换所需的配置和缓存 | 依赖输入、输出的宽高和像素格式 |
| `AVIOContext` | I/O 层 | 表示输出文件、网络连接或自定义读写通道 | 通常由 `avio_open()` 创建，并放入输出 `AVFormatContext::pb` |

整条视频转码链可以先记成下面这一行：

```text
输入 AVFormatContext
  → 输入 AVStream.codecpar
  → 解码 AVCodecContext
  → AVPacket → AVFrame
  → SwsContext → 编码 AVFrame
  → 编码 AVCodecContext
  → AVPacket
  → 输出 AVStream
  → 输出 AVFormatContext
```

其中有两个容易混淆的同名对象：

- 输入 `AVPacket`：从文件读出的压缩数据，送给解码器。
- 输出 `AVPacket`：编码器新产生的压缩数据，送给复用器。

两者类型相同，数据来源、时间基和生命周期不同。

---

## 2. 初始化阶段

初始化阶段只执行一次。它的核心任务是按照依赖顺序把对象创建好，使后面的循环只负责搬运和处理数据。

### 2.1 解码部分：初始化顺序、依赖和 API

#### 2.1.1 完整顺序

```text
1. avformat_open_input()
   创建输入 AVFormatContext，并打开输入源

2. avformat_find_stream_info()
   探测输入流，补全 AVStream 和 codecpar

3. av_find_best_stream()
   选出视频流索引 video_stream_index

4. input_stream = input_format->streams[video_stream_index]
   得到该流的 AVStream 和 codecpar

5. avcodec_find_decoder(input_stream->codecpar->codec_id)
   根据容器给出的 codec id 查找 AVCodec

6. avcodec_alloc_context3(decoder)
   依赖 AVCodec 创建解码 AVCodecContext

7. avcodec_parameters_to_context(decoder_ctx, input_stream->codecpar)
   将容器参数复制到解码器上下文

8. avcodec_open2(decoder_ctx, decoder, nullptr)
   打开解码器

9. av_packet_alloc()、av_frame_alloc()
   创建循环阶段复用的输入压缩包和解码帧
```

依赖关系可以概括为：

```text
输入地址
  → 输入 AVFormatContext
  → AVStream
  → AVCodecParameters.codec_id
  → AVCodec
  → AVCodecContext
```

`AVStream` 必须先由解复用器识别出来，程序才能知道该找 H.264、H.265、MPEG-2 Video 还是其他解码器。

#### 2.1.2 `AVFormatContext`：打开并探测输入容器

```cpp
AVFormatContext* input_format = nullptr;

int ret = avformat_open_input(
    &input_format,
    input_url,
    nullptr,
    nullptr
);
```

`avformat_open_input()` 根据文件内容和扩展名探测 MP4、MPEG-TS、FLV 等封装格式，并建立输入上下文。成功后，`input_format` 持有解复用器状态和流列表。

```cpp
ret = avformat_find_stream_info(input_format, nullptr);
```

`avformat_find_stream_info()` 会继续读取少量数据，补全每条 `AVStream` 的参数。依赖它得到的信息包括 codec id、宽高、帧率估计和时间基。实时流调用它时可能阻塞，因此工程里还要配置超时或中断回调。

#### 2.1.3 `AVStream` 和 `AVCodecParameters`：定位视频流并交接参数

```cpp
const int video_stream_index = av_find_best_stream(
    input_format,
    AVMEDIA_TYPE_VIDEO,
    -1,
    -1,
    nullptr,
    0
);

AVStream* input_stream = input_format->streams[video_stream_index];
AVCodecParameters* codecpar = input_stream->codecpar;
```

一个容器可能同时含有视频、音频和字幕。`video_stream_index` 是后续过滤输入包的依据：只有 `packet->stream_index == video_stream_index` 的包才送入视频解码器。

`codecpar` 主要是容器层与编解码层之间的参数快照。常用字段包括：

```cpp
codecpar->codec_type;  // 视频、音频或其他类型
codecpar->codec_id;    // AV_CODEC_ID_H264 等
codecpar->width;
codecpar->height;
codecpar->format;      // 有时未知，以实际解码帧为准
codecpar->extradata;   // SPS/PPS、配置记录等额外数据
```

不要直接使用 `codecpar` 执行解码。它没有解码器的内部缓存、线程状态和参考帧。

#### 2.1.4 `AVCodec` 和解码 `AVCodecContext`：创建真正的解码器

```cpp
const AVCodec* decoder = avcodec_find_decoder(codecpar->codec_id);
AVCodecContext* decoder_ctx = avcodec_alloc_context3(decoder);

ret = avcodec_parameters_to_context(decoder_ctx, codecpar);
ret = avcodec_open2(decoder_ctx, decoder, nullptr);
```

这里的创建顺序不能交换：

1. `codecpar->codec_id` 决定查找哪个 `AVCodec`。
2. `AVCodec` 参与创建 `AVCodecContext`。
3. `codecpar` 中的参数复制进 `AVCodecContext`。
4. 参数准备好以后调用 `avcodec_open2()`。

`AVCodec` 可以理解为无状态的“实现描述”；`AVCodecContext` 才保存当前视频的解码状态。多个视频即使都使用 H.264，也应有各自的 `AVCodecContext`。

#### 2.1.5 `AVPacket` 和解码 `AVFrame`：提前创建循环工作对象

```cpp
AVPacket* input_packet = av_packet_alloc();
AVFrame* decoded_frame = av_frame_alloc();
```

初始化阶段只创建对象壳，循环阶段再反复填充内容：

- `input_packet` 接收 `av_read_frame()` 读出的压缩数据。
- `decoded_frame` 接收 `avcodec_receive_frame()` 输出的原始图像。

每轮处理完调用 `av_packet_unref()` 或 `av_frame_unref()` 释放内部引用，对象本身可以继续复用。

### 2.2 编码部分：初始化顺序、依赖和 API

这里的“编码部分”同时包括像素转换、编码和复用初始化，因为输出编码器产生的包最终必须写入某个容器。

#### 2.2.1 完整顺序

```text
1. avformat_alloc_output_context2()
   根据输出文件名创建输出 AVFormatContext

2. avcodec_find_encoder()
   选择输出编码器 AVCodec

3. avformat_new_stream()
   在输出容器创建视频 AVStream

4. avcodec_alloc_context3(encoder)
   创建编码 AVCodecContext

5. 根据解码器参数和目标要求填写 encoder_ctx
   width、height、pix_fmt、time_base、framerate、bit_rate 等

6. 必要时设置 AV_CODEC_FLAG_GLOBAL_HEADER

7. avcodec_open2()
   打开编码器，编码器可能补全 profile、level、extradata 等信息

8. avcodec_parameters_from_context()
   将打开后的编码参数复制给 output_stream->codecpar

9. 设置 output_stream->time_base

10. av_frame_alloc() + av_frame_get_buffer()
    创建并分配编码输入帧

11. 将 SwsContext* 初始化为 nullptr
    第一张真实解码帧到来后再用 sws_getCachedContext() 创建

12. avio_open()
    创建 AVIOContext 并放入 output_format->pb

13. avformat_write_header()
    写输出容器头

14. av_packet_alloc()
    创建接收编码结果的输出包
```

核心依赖关系如下：

```text
解码参数 + 输出要求
  → 编码 AVCodecContext
  → avcodec_open2()
  → encoder_ctx 中最终参数和 extradata
  → output_stream->codecpar
  → avformat_write_header()
```

因此，容器头必须在编码器打开、参数复制给输出流之后再写。MP4 等容器需要把编码器生成的配置信息写进文件头。

#### 2.2.2 输出 `AVFormatContext` 和 `AVStream`：建立目标容器

```cpp
AVFormatContext* output_format = nullptr;

ret = avformat_alloc_output_context2(
    &output_format,
    nullptr,
    nullptr,
    output_url
);

AVStream* output_stream = avformat_new_stream(output_format, nullptr);
```

`avformat_alloc_output_context2()` 通常根据文件扩展名选择复用器，例如 `.mp4` 选择 MP4，`.ts` 选择 MPEG-TS。

`avformat_new_stream()` 创建的 `AVStream` 隶属于输出容器。它不执行编码，只描述即将写入容器的那条视频流。

#### 2.2.3 `AVCodec` 和编码 `AVCodecContext`：准备编码参数

```cpp
const AVCodec* encoder = avcodec_find_encoder(AV_CODEC_ID_H264);
AVCodecContext* encoder_ctx = avcodec_alloc_context3(encoder);

encoder_ctx->width = decoder_ctx->width;
encoder_ctx->height = decoder_ctx->height;
encoder_ctx->pix_fmt = AV_PIX_FMT_YUV420P;
encoder_ctx->time_base = AVRational{1, 30};
encoder_ctx->framerate = AVRational{30, 1};
encoder_ctx->bit_rate = 2'000'000;
encoder_ctx->gop_size = 60;
encoder_ctx->max_b_frames = 2;
```

这些参数来自两个方向：

- `width`、`height` 通常参考解码端或业务要求。
- `pix_fmt` 必须是编码器支持的像素格式。
- `time_base`、`framerate` 来自目标帧率设计。
- 码率、GOP、B 帧数量来自输出质量与延迟要求。

若复用器要求全局头，需要在打开编码器前设置：

```cpp
if (output_format->oformat->flags & AVFMT_GLOBALHEADER) {
    encoder_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
}
```

然后打开编码器，并把最终参数交给输出流：

```cpp
ret = avcodec_open2(encoder_ctx, encoder, nullptr);

ret = avcodec_parameters_from_context(
    output_stream->codecpar,
    encoder_ctx
);

output_stream->time_base = encoder_ctx->time_base;
```

`avcodec_parameters_from_context()` 的方向是编码器上下文到输出流参数。它与解码初始化中的 `avcodec_parameters_to_context()` 方向相反：

```text
解码：input_stream->codecpar  → decoder_ctx
编码：encoder_ctx             → output_stream->codecpar
```

#### 2.2.4 编码 `AVFrame` 和 `SwsContext`：准备编码器需要的图像

```cpp
AVFrame* encode_frame = av_frame_alloc();
encode_frame->format = encoder_ctx->pix_fmt;
encode_frame->width = encoder_ctx->width;
encode_frame->height = encoder_ctx->height;

ret = av_frame_get_buffer(encode_frame, 32);
```

编码 `AVFrame` 自己只保存数据指针和元数据。`av_frame_get_buffer()` 才为各个图像平面分配实际内存。

解码器输出格式未必等于编码器输入格式。例如解码得到 NV12，编码器要求 YUV420P，就需要 `SwsContext`。

这里适合采用延迟初始化：编码初始化阶段先把指针设为空，等循环阶段取得第一张真实解码帧后，再根据它的宽高和像素格式创建转换上下文。

```cpp
SwsContext* sws_ctx = nullptr;

// 第一张 decoded_frame 到来后调用
sws_ctx = sws_getCachedContext(
    sws_ctx,
    decoded_frame->width,
    decoded_frame->height,
    static_cast<AVPixelFormat>(decoded_frame->format),
    encoder_ctx->width,
    encoder_ctx->height,
    encoder_ctx->pix_fmt,
    SWS_BILINEAR,
    nullptr,
    nullptr,
    nullptr
);
```

这样安排是由依赖关系决定的：`SwsContext` 的输入参数来自真实的 `decoded_frame`，输出参数来自已经打开的 `encoder_ctx`。输入发生分辨率或像素格式变化时，后续调用 `sws_getCachedContext()` 会检查旧上下文能否复用，不能复用时重新分配。

#### 2.2.5 `AVIOContext` 和容器头：让输出真正可写

```cpp
if (!(output_format->oformat->flags & AVFMT_NOFILE)) {
    ret = avio_open(&output_format->pb, output_url, AVIO_FLAG_WRITE);
}

ret = avformat_write_header(output_format, nullptr);
```

依赖顺序是：

1. 输出上下文先确定复用器。
2. 编码器打开并把参数复制给输出流。
3. `avio_open()` 建立底层输出通道。
4. `avformat_write_header()` 根据输出流参数写容器头。

`AVFMT_NOFILE` 表示该复用器不需要由程序调用 `avio_open()`，因此必须先检查标志。

最后创建接收编码结果的包：

```cpp
AVPacket* output_packet = av_packet_alloc();
```

---

## 3. 循环阶段

循环阶段处理整段视频。为了理解调用关系，可以把它拆成两个连续状态机：解码状态机负责 `Packet → Frame`，编码状态机负责 `Frame → Packet`。

### 3.1 解码部分：循环顺序、对象调用和 API

#### 3.1.1 单次循环的完整顺序

```text
1. av_read_frame(input_format, input_packet)
   解复用器把下一个压缩包写入 input_packet

2. 检查 input_packet->stream_index
   只处理目标视频流，其余包直接 unref

3. avcodec_send_packet(decoder_ctx, input_packet)
   将压缩包送入解码器

4. av_packet_unref(input_packet)
   释放本轮输入包持有的引用

5. 反复 avcodec_receive_frame(decoder_ctx, decoded_frame)
   每成功一次就得到一帧原始图像

6. 对每个 decoded_frame 调用后续转换和编码逻辑

7. av_frame_unref(decoded_frame)
   释放本轮解码帧持有的引用

8. receive 返回 AVERROR(EAGAIN)
   当前输出已取完，回到 av_read_frame()
```

对应的对象调用关系是：

```text
input_format
  └─av_read_frame()→ input_packet
                         └─avcodec_send_packet()→ decoder_ctx
                                                       └─avcodec_receive_frame()→ decoded_frame
```

#### 3.1.2 `av_read_frame()`：解复用器输出压缩包

```cpp
ret = av_read_frame(input_format, input_packet);
```

返回值的含义：

- `ret >= 0`：成功取得一个包。
- `ret == AVERROR_EOF`：输入已经读完，进入解码器冲刷阶段。
- 其他负数：发生读取或解复用错误。

读取成功后，常用字段包括：

```cpp
input_packet->stream_index;
input_packet->pts;
input_packet->dts;
input_packet->duration;
input_packet->data;
input_packet->size;
```

一个 `AVPacket` 不保证对应一帧图像。它只是封装层交给编解码层的一块压缩数据。帧边界和内部缓存由解析器及解码器处理。

#### 3.1.3 `avcodec_send_packet()`：把包送进解码器

```cpp
ret = avcodec_send_packet(decoder_ctx, input_packet);
```

现代 FFmpeg 使用 send/receive API。发送成功只表示解码器接收了输入，不代表立刻产生一帧。B 帧重排序、参考帧依赖和内部缓存都会造成延迟。

`AVERROR(EAGAIN)` 表示解码器当前还有输出没有取完。正确处理方式是先继续调用 `avcodec_receive_frame()`，取空以后再重试发送。工程代码不应把 EAGAIN 当作视频损坏。

发送完成后可以解除输入包引用：

```cpp
av_packet_unref(input_packet);
```

解码器已经保留了它真正需要的数据引用。

#### 3.1.4 `avcodec_receive_frame()`：取出零帧、一帧或多帧

```cpp
while (true) {
    ret = avcodec_receive_frame(decoder_ctx, decoded_frame);

    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        break;
    }
    if (ret < 0) {
        // 解码错误
    }

    // decoded_frame 此时是一帧可处理的原始图像
    process_decoded_frame(decoded_frame);
    av_frame_unref(decoded_frame);
}
```

必须使用循环接收，因为一次发送和一次接收没有固定的一一对应关系。

`decoded_frame` 常用字段：

```cpp
decoded_frame->data[];      // 各图像平面起始地址
decoded_frame->linesize[];  // 各平面每行跨度
decoded_frame->width;
decoded_frame->height;
decoded_frame->format;
decoded_frame->pts;
decoded_frame->best_effort_timestamp;
```

时间戳优先使用 `best_effort_timestamp`，再从输入流时间基转换到编码器时间基：

```cpp
encode_frame->pts = av_rescale_q(
    decoded_frame->best_effort_timestamp,
    input_stream->time_base,
    encoder_ctx->time_base
);
```

如果输入没有有效时间戳，才由程序按照目标帧率生成递增 PTS。

### 3.2 编码部分：转换、编码和写包顺序

每得到一个 `decoded_frame`，就执行下面的子循环。

#### 3.2.1 单帧处理的完整顺序

```text
1. av_frame_make_writable(encode_frame)
   确保编码帧缓冲区可以被覆盖

2. sws_getCachedContext()
   按当前 decoded_frame 和 encoder_ctx 参数取得转换上下文

3. sws_scale()
   decoded_frame → encode_frame

4. 为 encode_frame 设置 PTS

5. avcodec_send_frame(encoder_ctx, encode_frame)
   把原始帧送入编码器

6. 反复 avcodec_receive_packet(encoder_ctx, output_packet)
   取得编码后的压缩包

7. av_packet_rescale_ts()
   encoder_ctx->time_base → output_stream->time_base

8. 设置 output_packet->stream_index

9. av_interleaved_write_frame(output_format, output_packet)
   交给复用器写入输出容器

10. av_packet_unref(output_packet)
    清理本轮编码包，继续接收或处理下一帧
```

对象调用关系如下：

```text
decoded_frame
  └─sws_scale(sws_ctx)→ encode_frame
                           └─avcodec_send_frame()→ encoder_ctx
                                                        └─avcodec_receive_packet()→ output_packet
                                                                                       └─av_interleaved_write_frame()→ output_format
```

#### 3.2.2 `av_frame_make_writable()` 和 `sws_scale()`：准备编码输入帧

```cpp
ret = av_frame_make_writable(encode_frame);

sws_ctx = sws_getCachedContext(
    sws_ctx,
    decoded_frame->width,
    decoded_frame->height,
    static_cast<AVPixelFormat>(decoded_frame->format),
    encoder_ctx->width,
    encoder_ctx->height,
    encoder_ctx->pix_fmt,
    SWS_BILINEAR,
    nullptr,
    nullptr,
    nullptr
);

ret = sws_scale(
    sws_ctx,
    decoded_frame->data,
    decoded_frame->linesize,
    0,
    decoded_frame->height,
    encode_frame->data,
    encode_frame->linesize
);
```

`av_frame_make_writable()` 很重要。`AVFrame` 的底层缓冲区采用引用计数，编码器可能仍持有上一帧数据。这个 API 会在必要时分配可写副本，避免覆盖仍被使用的内存。

`sws_getCachedContext()` 的输入参数来自当前解码帧，输出参数来自编码器上下文。它恰好体现了对象依赖：转换器连接了解码端真实输出和编码端明确要求。

#### 3.2.3 `avcodec_send_frame()`：把原始帧送入编码器

```cpp
ret = avcodec_send_frame(encoder_ctx, encode_frame);
```

发送一帧后，编码器可能暂时没有包输出，例如它正在等待 B 帧重排序或凑齐内部编码结构。因此随后仍要循环调用 receive。

若返回 `AVERROR(EAGAIN)`，先取空已有的编码包，再重试发送当前帧。

#### 3.2.4 `avcodec_receive_packet()`：取得编码结果

```cpp
while (true) {
    ret = avcodec_receive_packet(encoder_ctx, output_packet);

    if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
        break;
    }
    if (ret < 0) {
        // 编码错误
    }

    write_encoded_packet(output_packet);
    av_packet_unref(output_packet);
}
```

输出包的 PTS 和 DTS 当前处于 `encoder_ctx->time_base`。复用器要求它们处于 `output_stream->time_base`，所以写入前需要转换：

```cpp
av_packet_rescale_ts(
    output_packet,
    encoder_ctx->time_base,
    output_stream->time_base
);

output_packet->stream_index = output_stream->index;
```

PTS 表示计划显示时间，DTS 表示解码顺序时间。存在 B 帧时两者可能不同，编码器会负责生成这种重排序关系，应用层应同时保留它们。

#### 3.2.5 `av_interleaved_write_frame()`：交给复用器

```cpp
ret = av_interleaved_write_frame(output_format, output_packet);
```

复用器根据 `stream_index`、PTS、DTS 和 duration，把包写进 MP4、MPEG-TS 等容器。如果还有音频流，`av_interleaved_write_frame()` 也会按时间戳协调音视频包的交错顺序。

此时的层次是：

```text
编码器产生 H.264/H.265 等压缩包
  → 复用器给包补充容器所需的索引、时间和组织结构
  → AVIOContext 把最终字节写到文件或网络
```

---

## 4. 输入结束后的冲刷和清理

主循环读到 EOF 后，解码器和编码器内部可能仍缓存着帧或包，不能直接写 trailer 后退出。

### 4.1 冲刷解码器

```text
avcodec_send_packet(decoder_ctx, nullptr)
  → 反复 avcodec_receive_frame()
  → 每个剩余 decoded_frame 仍然执行转换和编码
  → receive 返回 AVERROR_EOF
```

空 `AVPacket` 是“输入结束”的信号。它会推动解码器输出因重排序而滞留的帧。

### 4.2 冲刷编码器并结束容器

解码器完全排空以后，再冲刷编码器：

```text
avcodec_send_frame(encoder_ctx, nullptr)
  → 反复 avcodec_receive_packet()
  → 每个剩余 output_packet 继续缩放时间戳并写入复用器
  → receive 返回 AVERROR_EOF
  → av_write_trailer(output_format)
```

空 `AVFrame` 是编码结束信号。`av_write_trailer()` 会写文件尾、索引等结构。MP4 缺少 trailer 时，播放器可能无法正常定位或播放。

### 4.3 清理顺序和所有权

推荐按使用链的反方向释放：

```text
AVPacket / AVFrame
  → SwsContext
  → AVCodecContext
  → 输出 AVIOContext
  → 输出 AVFormatContext
  → 输入 AVFormatContext
```

对应 API：

```cpp
av_packet_free(&packet);
av_frame_free(&frame);
sws_freeContext(sws_ctx);
avcodec_free_context(&codec_ctx);
avio_closep(&output_format->pb);
avformat_free_context(output_format);
avformat_close_input(&input_format);
```

`avformat_close_input()` 会关闭输入 I/O 并释放输入上下文。输出端通常先关闭 `pb`，再调用 `avformat_free_context()`。

---

## 5. 常见顺序错误

### 5.1 写容器头早于打开编码器

后果：输出流可能缺少编码器最终生成的 extradata、profile 或其他信息。

正确顺序：

```text
avcodec_open2()
  → avcodec_parameters_from_context()
  → avformat_write_header()
```

### 5.2 假设一次 send 必然对应一次 receive

后果：丢帧、遗漏编码包，或者错误地把 EAGAIN 当成失败。

正确模型：每次成功 send 后循环 receive，直到 EAGAIN；EOF 后再分别冲刷解码器和编码器。

### 5.3 写包前没有转换时间基

后果：播放速度异常、时间戳不单调、音画不同步或复用器拒绝写入。

正确处理：

```cpp
av_packet_rescale_ts(packet, encoder_ctx->time_base, output_stream->time_base);
```

### 5.4 用解码器上下文的像素格式代替实际帧格式

后果：遇到动态分辨率、硬件帧或格式变化时转换失败。

正确处理：循环里读取 `decoded_frame->width`、`height` 和 `format`，通过 `sws_getCachedContext()` 更新转换配置。

### 5.5 忘记 `unref`

后果：长视频运行时内存持续增长。

原则：每次成功取得并处理完一个 `AVPacket` 或 `AVFrame`，都应解除它持有的内部引用。

---

## 6. Demo：按“初始化 + 循环”组织视频转码程序

下面的 C++ Demo 读取一个输入媒体文件，解码第一条视频流，转换为 YUV420P，再编码为 H.264 并写入输出容器。为了让对象依赖清晰，代码也按本文结构拆成初始化函数、循环函数和冲刷函数。

示例省略音频复制、复杂选项和硬件加速，只保留视频主链。

### 6.1 完整代码

```cpp
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/error.h>
#include <libavutil/imgutils.h>
#include <libavutil/mathematics.h>
#include <libswscale/swscale.h>
}

// 把 FFmpeg 的负错误码转换为可读字符串。
// 输入：errnum 是某个 FFmpeg API 返回的错误码。
// 输出：返回独立的 std::string，调用者不需要管理 FFmpeg 缓冲区。
static std::string ff_error(int errnum) {
    char buffer[AV_ERROR_MAX_STRING_SIZE]{};
    av_strerror(
        errnum,         // errnum：需要解释的 FFmpeg 错误码。
        buffer,         // errbuf：接收错误文本的字符数组。
        sizeof(buffer)  // errbuf_size：字符数组容量，单位是字节。
    );
    return buffer;
}

// 统一检查 FFmpeg API 的返回值。
// 输入：ret 为 API 返回值；operation 是出错时显示的操作名称。
// 行为：ret < 0 时抛出异常，栈展开随后触发 Pipeline 析构并释放资源。
static void check(int ret, const char* operation) {
    if (ret < 0) {
        throw std::runtime_error(
            std::string(operation) + ": " + ff_error(ret)
        );
    }
}

// 集中持有整条转码链的状态。
// Pipeline 对所有带有 free/close API 的指针负最终释放责任；
// input_stream 和 output_stream 由各自的 AVFormatContext 持有，只保存借用指针。
struct Pipeline {
    AVFormatContext* input_format = nullptr;   // 输入容器及解复用状态；Pipeline 最终 close。
    AVFormatContext* output_format = nullptr;  // 输出容器及复用状态；Pipeline 最终 free。
    AVCodecContext* decoder_ctx = nullptr;     // 当前视频流的解码状态；Pipeline 独占。
    AVCodecContext* encoder_ctx = nullptr;     // H.264 编码状态；Pipeline 独占。
    AVStream* input_stream = nullptr;          // 借用指针；input_format 销毁后立即失效。
    AVStream* output_stream = nullptr;         // 借用指针；output_format 销毁后立即失效。
    int video_stream_index = -1;               // 目标视频流在输入流数组中的下标；-1 表示尚未找到。

    AVPacket* input_packet = nullptr;   // 循环复用：解复用器输出、解码器输入。
    AVPacket* output_packet = nullptr;  // 循环复用：编码器输出、复用器输入。
    AVFrame* decoded_frame = nullptr;   // 循环复用：解码器输出的原始图像。
    AVFrame* encode_frame = nullptr;    // 循环复用：转换后送入编码器的 YUV420P 图像。
    SwsContext* sws_ctx = nullptr;      // 像素转换缓存；输入格式变化时可由 API 重新分配。

    // 输入没有时间戳时生成备用 PTS；单位是 encoder_ctx->time_base 的一个刻度。
    int64_t generated_pts = 0;

    ~Pipeline() {
        // free API 接收二级指针，释放内部资源后还会把成员指针写回 nullptr。
        av_packet_free(
            &input_packet  // pkt：释放输入工作包及其数据引用，并把成员写回 nullptr。
        );
        av_packet_free(
            &output_packet  // pkt：释放输出工作包及其数据引用，并把成员写回 nullptr。
        );
        av_frame_free(
            &decoded_frame  // frame：释放解码帧及其图像引用，并把成员写回 nullptr。
        );
        av_frame_free(
            &encode_frame  // frame：释放编码帧及 av_frame_get_buffer 分配的图像内存。
        );

        sws_freeContext(
            sws_ctx  // swsContext：要释放的转换上下文；允许传 nullptr。
        );
        avcodec_free_context(
            &decoder_ctx  // avctx：关闭并释放解码上下文，随后写回 nullptr。
        );
        avcodec_free_context(
            &encoder_ctx  // avctx：关闭并释放编码上下文，随后写回 nullptr。
        );

        if (output_format != nullptr) {
            if (!(output_format->oformat->flags & AVFMT_NOFILE)) {
                avio_closep(
                    &output_format->pb  // s：关闭底层输出，并把 pb 写回 nullptr。
                );
            }
            avformat_free_context(
                output_format  // s：释放输出容器及其内部 AVStream；不会关闭自定义 pb。
            );
        }

        avformat_close_input(
            &input_format  // ps：关闭输入 I/O、释放输入上下文，并把指针写回 nullptr。
        );
    }
};

// 解码初始化。
// 输入：p 接收并持有新建对象；input_url 是本地文件路径或 FFmpeg 支持的输入 URL。
// 输出：成功后 p 中具备输入容器、目标视频流、已打开的解码器及循环工作对象。
static void init_decoder(Pipeline& p, const char* input_url) {
    check(
        avformat_open_input(
            &p.input_format,  // ps：输出参数；成功后指向新建的输入 AVFormatContext。
            input_url,        // url：输入文件路径或网络地址。
            nullptr,          // fmt：不强制指定解复用器，由 FFmpeg 自动探测格式。
            nullptr           // options：没有额外字典选项；调用后未识别项会留在字典中。
        ),
        "avformat_open_input"
    );

    check(
        avformat_find_stream_info(
            p.input_format,  // ic：已经打开的输入上下文，函数会补全它的 streams 信息。
            nullptr          // options：不为各条流提供单独的探测选项字典。
        ),
        "avformat_find_stream_info"
    );

    p.video_stream_index = av_find_best_stream(
        p.input_format,      // ic：从这个输入容器的 streams 中查找。
        AVMEDIA_TYPE_VIDEO,  // type：只查找视频流。
        -1,                  // wanted_stream_nb：-1 表示不指定固定流下标。
        -1,                  // related_stream：-1 表示不要求与某条流相关联。
        nullptr,             // decoder_ret：本次只要流下标，不接收推荐解码器指针。
        0                    // flags：当前接口没有需要开启的查找标志。
    );
    // 返回非负数时它就是流下标；返回负数说明没有可用视频流或发生探测错误。
    check(p.video_stream_index, "av_find_best_stream");

    // streams 与 codecpar 都由 input_format 拥有；这里只借用，不单独释放。
    p.input_stream = p.input_format->streams[p.video_stream_index];
    AVCodecParameters* codecpar = p.input_stream->codecpar;

    const AVCodec* decoder = avcodec_find_decoder(
        codecpar->codec_id  // id：容器中记录的编码类型，例如 AV_CODEC_ID_H264。
    );
    if (decoder == nullptr) {
        throw std::runtime_error("找不到输入视频对应的解码器");
    }

    p.decoder_ctx = avcodec_alloc_context3(
        decoder  // codec：用该解码器的默认值初始化上下文；返回对象仍需复制本视频参数。
    );
    if (p.decoder_ctx == nullptr) {
        throw std::bad_alloc();
    }

    check(
        avcodec_parameters_to_context(
            p.decoder_ctx,  // codec：目标解码上下文，函数会改写其中对应的媒体参数。
            codecpar        // par：输入流参数来源；函数复制内容，不转移 codecpar 所有权。
        ),
        "avcodec_parameters_to_context"
    );

    check(
        avcodec_open2(
            p.decoder_ctx,  // avctx：已复制宽高、extradata 等参数的解码器上下文。
            decoder,        // codec：要打开的具体解码器实现。
            nullptr         // options：不传私有解码选项；未消费选项本可通过字典取回。
        ),
        "avcodec_open2 decoder"
    );

    p.input_packet = av_packet_alloc();  // 返回空包对象，内部压缩数据由 av_read_frame 填入。
    p.decoded_frame = av_frame_alloc();  // 返回空帧对象，图像引用由 receive_frame 填入。
    if (p.input_packet == nullptr || p.decoded_frame == nullptr) {
        throw std::bad_alloc();
    }
}

// 编码和复用初始化。
// 输入：p 已完成解码初始化；output_url 是输出文件路径。
// 输出：成功后编码器、输出流、帧缓冲、输出 I/O 均已就绪，容器头已经写入。
static void init_encoder_and_muxer(Pipeline& p, const char* output_url) {
    check(
        avformat_alloc_output_context2(
            &p.output_format,  // ctx：输出参数；成功后指向新建的输出 AVFormatContext。
            nullptr,           // oformat：不直接传 AVOutputFormat，让 FFmpeg 选择。
            nullptr,           // format_name：不指定复用器名称，改由文件名推断。
            output_url         // filename：用于推断 .mp4/.ts 等格式，也保存为输出 URL。
        ),
        "avformat_alloc_output_context2"
    );

    const AVCodec* encoder = avcodec_find_encoder(
        AV_CODEC_ID_H264  // id：明确要求查找一个 H.264 编码器实现。
    );
    if (encoder == nullptr) {
        throw std::runtime_error("当前 FFmpeg 构建中没有 H.264 编码器");
    }

    p.output_stream = avformat_new_stream(
        p.output_format,  // s：新流要加入的输出容器；容器取得新流所有权。
        nullptr           // c：现代用法可传 nullptr，编码参数稍后从 encoder_ctx 复制。
    );
    if (p.output_stream == nullptr) {
        throw std::bad_alloc();
    }

    p.encoder_ctx = avcodec_alloc_context3(
        encoder  // codec：用选定编码器的默认配置创建上下文。
    );
    if (p.encoder_ctx == nullptr) {
        throw std::bad_alloc();
    }

    AVRational frame_rate = av_guess_frame_rate(
        p.input_format,  // ctx：输入容器，提供全局探测信息。
        p.input_stream,  // stream：需要估算帧率的输入视频流。
        nullptr          // frame：没有指定某张帧，使用流级信息进行估算。
    );
    // 返回的 AVRational 表示“每秒多少帧”，例如 30/1；无有效结果时使用 30 fps。
    if (frame_rate.num <= 0 || frame_rate.den <= 0) {
        frame_rate = AVRational{30, 1};
    }

    p.encoder_ctx->width = p.decoder_ctx->width;    // 输出宽度，单位是像素。
    p.encoder_ctx->height = p.decoder_ctx->height;  // 输出高度，单位是像素。
    p.encoder_ctx->pix_fmt = AV_PIX_FMT_YUV420P;    // 编码器接收的原始像素布局。
    p.encoder_ctx->framerate = frame_rate;          // 显示帧率，单位是帧/秒。
    p.encoder_ctx->time_base = av_inv_q(
        frame_rate  // q：对“帧/秒”取倒数，得到“一帧占多少秒”的时间基。
    );
    p.encoder_ctx->bit_rate = 2'000'000;             // 目标平均码率，单位是 bit/s。
    p.encoder_ctx->gop_size = 60;                    // 最长关键帧间隔，单位是帧。
    p.encoder_ctx->max_b_frames = 2;                 // 相邻参考帧之间最多使用 2 张 B 帧。

    if (p.output_format->oformat->flags & AVFMT_GLOBALHEADER) {
        p.encoder_ctx->flags |= AV_CODEC_FLAG_GLOBAL_HEADER;
    }

    check(
        avcodec_open2(
            p.encoder_ctx,  // avctx：已填写尺寸、像素格式、时间基和码率的编码上下文。
            encoder,        // codec：要打开的 H.264 编码器实现。
            nullptr         // options：不传编码器私有选项；实际项目可在此设置 preset 等。
        ),
        "avcodec_open2 encoder"
    );

    check(
        avcodec_parameters_from_context(
            p.output_stream->codecpar,  // par：目标流参数，复用器写 header 时读取它。
            p.encoder_ctx               // codec：参数来源；复制内容，不转移上下文所有权。
        ),
        "avcodec_parameters_from_context"
    );
    // 先给出期望时间基；avformat_write_header 后复用器仍有权调整该字段。
    p.output_stream->time_base = p.encoder_ctx->time_base;

    p.encode_frame = av_frame_alloc();    // 空帧壳，下面还要声明格式并分配图像内存。
    p.output_packet = av_packet_alloc();  // 空包壳，循环中接收编码器输出。
    if (p.encode_frame == nullptr || p.output_packet == nullptr) {
        throw std::bad_alloc();
    }

    p.encode_frame->format = p.encoder_ctx->pix_fmt;
    p.encode_frame->width = p.encoder_ctx->width;
    p.encode_frame->height = p.encoder_ctx->height;
    check(
        av_frame_get_buffer(
            p.encode_frame,  // frame：已设置 format、width、height 的目标帧。
            32               // align：各数据平面按 32 字节对齐，便于 SIMD 访问。
        ),
        "av_frame_get_buffer"
    );

    if (!(p.output_format->oformat->flags & AVFMT_NOFILE)) {
        check(
            avio_open(
                &p.output_format->pb,  // s：输出参数；成功后由 pb 指向新 AVIOContext。
                output_url,            // url：要创建或覆盖的输出文件路径。
                AVIO_FLAG_WRITE        // flags：以写模式打开底层 I/O。
            ),
            "avio_open"
        );
    }

    check(
        avformat_write_header(
            p.output_format,  // s：包含输出流参数且已经打开 pb 的复用上下文。
            nullptr           // options：不传复用器私有选项字典。
        ),
        "avformat_write_header"
    );
}

// 取出编码器当前能够输出的所有压缩包，并立即交给复用器。
// 输入：p 提供编码器、复用器和可复用 output_packet；flushing 表示是否处于结束冲刷。
// 输出：普通阶段遇到 EAGAIN 正常返回；冲刷阶段一直取到 AVERROR_EOF。
static void receive_and_write_packets(Pipeline& p, bool flushing) {
    while (true) {
        const int ret = avcodec_receive_packet(
            p.encoder_ctx,   // avctx：从这个已打开的编码器取结果。
            p.output_packet  // avpkt：输出参数；成功时得到压缩数据及编码时间戳。
        );

        if (ret == AVERROR_EOF) {
            // 编码器已经完全冲刷，后续不会再产生包。
            return;
        }
        if (ret == AVERROR(EAGAIN)) {
            if (flushing) {
                // 已发送空帧后应持续接收到 EOF；这里出现 EAGAIN 表示调用状态不符合预期。
                throw std::runtime_error("编码器冲刷时意外返回 EAGAIN");
            }
            // 当前输出已取空。调用者应先发送下一张原始帧，再次进入本函数。
            return;
        }
        check(ret, "avcodec_receive_packet");

        av_packet_rescale_ts(
            p.output_packet,             // pkt：原地修改其中的 pts、dts 和 duration。
            p.encoder_ctx->time_base,    // tb_src：当前时间戳使用的编码器时间基。
            p.output_stream->time_base   // tb_dst：复用器要求的输出流时间基。
        );
        // 复用器依靠 stream_index 判断该包属于输出容器中的哪条流。
        p.output_packet->stream_index = p.output_stream->index;

        check(
            av_interleaved_write_frame(
                p.output_format,  // s：目标复用上下文，内部通过 pb 写到底层文件。
                p.output_packet   // pkt：已换算时间基且已设置流下标的编码包。
            ),
            "av_interleaved_write_frame"
        );
        // write_frame 会消费包引用；再次 unref 是安全的，并确保工作包恢复为空状态。
        av_packet_unref(
            p.output_packet  // pkt：解除本包内部引用；AVPacket 对象本身留给下一次 receive 复用。
        );
    }
}

// 把一张解码帧转换为编码器要求的格式，然后送入编码器。
// 输入：p.decoded_frame 必须持有当前有效图像。
// 输出：编码后的零个或多个 AVPacket 会在本函数内写入输出容器。
static void convert_and_encode(Pipeline& p) {
    check(
        av_frame_make_writable(
            p.encode_frame  // frame：确保转换目标缓冲区没有被编码器共享为只读引用。
        ),
        "av_frame_make_writable"
    );

    p.sws_ctx = sws_getCachedContext(
        p.sws_ctx,  // context：旧缓存；参数一致时复用，不一致时释放并重新分配。
        p.decoded_frame->width,   // srcW：输入图像宽度，单位是像素。
        p.decoded_frame->height,  // srcH：输入图像高度，单位是像素。
        static_cast<AVPixelFormat>(p.decoded_frame->format), // srcFormat：实际解码像素格式。
        p.encoder_ctx->width,     // dstW：编码器要求的输出宽度，单位是像素。
        p.encoder_ctx->height,    // dstH：编码器要求的输出高度，单位是像素。
        p.encoder_ctx->pix_fmt,   // dstFormat：编码器要求的 YUV420P 格式。
        SWS_BILINEAR,             // flags：缩放时采用双线性插值。
        nullptr,                  // srcFilter：不附加自定义输入滤镜。
        nullptr,                  // dstFilter：不附加自定义输出滤镜。
        nullptr                   // param：不传算法专用参数，使用默认值。
    );
    if (p.sws_ctx == nullptr) {
        throw std::runtime_error("无法创建 SwsContext");
    }

    const int scaled_height = sws_scale(
        p.sws_ctx,                  // c：已配置输入/输出尺寸和格式的转换上下文。
        p.decoded_frame->data,      // srcSlice：输入各颜色平面的起始地址数组。
        p.decoded_frame->linesize,  // srcStride：输入各平面每行跨度，单位是字节。
        0,                          // srcSliceY：从输入图像第 0 行开始处理。
        p.decoded_frame->height,    // srcSliceH：本次处理完整图像高度。
        p.encode_frame->data,       // dst：接收转换结果的各颜色平面地址。
        p.encode_frame->linesize    // dstStride：输出各平面每行跨度，单位是字节。
    );
    if (scaled_height != p.encoder_ctx->height) {
        throw std::runtime_error("sws_scale 输出高度不完整");
    }

    const int64_t source_pts =
        p.decoded_frame->best_effort_timestamp;

    if (source_pts != AV_NOPTS_VALUE) {
        p.encode_frame->pts = av_rescale_q(
            source_pts,                   // a：输入帧时间戳的整数刻度值。
            p.input_stream->time_base,    // bq：输入刻度对应的秒数。
            p.encoder_ctx->time_base      // cq：转换后的目标刻度单位。
        );
        p.generated_pts = p.encode_frame->pts + 1;
    } else {
        p.encode_frame->pts = p.generated_pts++;
    }

    check(
        avcodec_send_frame(
            p.encoder_ctx,  // avctx：接收原始帧的编码器上下文。
            p.encode_frame  // frame：带有效 YUV 数据和编码器时间基 PTS 的输入帧。
        ),
        "avcodec_send_frame"
    );
    receive_and_write_packets(p, false);
}

// 取出解码器当前能够输出的所有原始帧。
// 输入：p.decoder_ctx 中已经送入压缩包；flushing 表示是否已发送空包结束信号。
// 输出：每张成功取得的帧都会完成转换、编码和写包；函数返回时 decoded_frame 为空引用状态。
static void receive_and_process_frames(Pipeline& p, bool flushing) {
    while (true) {
        const int ret = avcodec_receive_frame(
            p.decoder_ctx,   // avctx：从这个已打开的解码器取图像。
            p.decoded_frame  // frame：输出参数；成功时持有一张原始图像及时间戳。
        );

        if (ret == AVERROR_EOF) {
            // 解码器已经完全冲刷，内部不再保留可输出帧。
            return;
        }
        if (ret == AVERROR(EAGAIN)) {
            if (flushing) {
                // 已发送空包后预期最终得到 EOF；EAGAIN 表示状态推进不符合本 Demo 的假设。
                throw std::runtime_error("解码器冲刷时意外返回 EAGAIN");
            }
            // 当前可输出帧已经取空。调用者应读取并发送下一个压缩包。
            return;
        }
        check(ret, "avcodec_receive_frame");

        convert_and_encode(p);
        // 本帧已经被转换；解除解码帧内部缓冲引用，保留 AVFrame 对象供下一轮复用。
        av_frame_unref(
            p.decoded_frame  // frame：解除图像缓冲引用；AVFrame 对象本身留给下一次 receive 复用。
        );
    }
}

// 主循环：解复用压缩包，并驱动后面的解码、转换、编码和复用状态机。
// 输入：p 的所有初始化对象必须有效，且输出容器头已经写入。
// 输出：读到输入 EOF 时返回；解码器和编码器中的缓存由 flush_pipeline() 继续处理。
static void run_loop(Pipeline& p) {
    while (true) {
        const int read_ret = av_read_frame(
            p.input_format,  // s：从该输入容器继续读取并解复用。
            p.input_packet   // pkt：输出参数；成功时持有下一条流的一个压缩包。
        );

        if (read_ret == AVERROR_EOF) {
            // 输入已经没有新包。此时编解码器内部可能仍有缓存，交给冲刷阶段处理。
            break;
        }
        check(read_ret, "av_read_frame");

        if (p.input_packet->stream_index != p.video_stream_index) {
            // 当前包可能属于音频或字幕。本 Demo 不处理它，立即释放引用后读取下一包。
            av_packet_unref(
                p.input_packet  // pkt：丢弃非目标流数据，只清内部引用，保留包对象。
            );
            continue;
        }

        check(
            avcodec_send_packet(
                p.decoder_ctx,  // avctx：目标视频解码器。
                p.input_packet  // avpkt：属于目标视频流的压缩包；时间基来自 input_stream。
            ),
            "avcodec_send_packet"
        );
        // send 成功后解码器已经取得所需引用，工作包可以清空并交给下次 av_read_frame。
        av_packet_unref(
            p.input_packet  // pkt：解码器已接收数据，清空工作包供下一次 read 复用。
        );

        receive_and_process_frames(p, false);
    }
}

// 输入 EOF 后排空两级内部缓存，并完成输出容器。
// 顺序固定为：空包冲刷解码器 → 剩余帧送编码器 → 空帧冲刷编码器 → 写 trailer。
static void flush_pipeline(Pipeline& p) {
    // packet=nullptr 表示压缩输入已经结束；解码器随后输出重排序缓存中的剩余帧。
    check(
        avcodec_send_packet(
            p.decoder_ctx,  // avctx：需要进入 draining 状态的解码器。
            nullptr         // avpkt：空指针是一次结束信号，不代表“暂时没有包”。
        ),
        "flush decoder"
    );
    receive_and_process_frames(p, true);

    // frame=nullptr 表示原始帧已经全部送完；编码器开始输出 B 帧重排序等剩余包。
    check(
        avcodec_send_frame(
            p.encoder_ctx,  // avctx：需要进入 draining 状态的编码器。
            nullptr         // frame：空指针是编码结束信号。
        ),
        "flush encoder"
    );
    receive_and_write_packets(p, true);

    check(
        av_write_trailer(
            p.output_format  // s：写入索引和容器尾，并完成复用器状态。
        ),
        "av_write_trailer"
    );
}

// 命令行输入：argv[1] 为输入媒体，argv[2] 为输出文件。
// 返回：0 表示完成；1 表示参数数量错误；2 表示初始化或转码过程失败。
int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "用法: " << argv[0]
                  << " <input> <output.mp4>\n";
        return 1;
    }

    try {
        // main 持有 Pipeline；正常返回或异常退出都会执行析构，避免中途失败泄漏资源。
        Pipeline pipeline;

        // 初始化阶段：先解码端，再编码和复用端。
        init_decoder(pipeline, argv[1]);
        init_encoder_and_muxer(pipeline, argv[2]);

        // 循环阶段及结束冲刷。
        run_loop(pipeline);
        flush_pipeline(pipeline);

        std::cout << "转码完成\n";
        return 0;
    } catch (const std::exception& error) {
        // Pipeline 已在离开 try 作用域时析构；这里只报告错误并返回失败状态。
        std::cerr << "失败: " << error.what() << '\n';
        return 2;
    }
}
```

### 6.2 编译和运行

Linux 上可使用 `pkg-config` 提供编译参数：

```bash
g++ -std=c++17 transcode.cpp -o transcode \
  $(pkg-config --cflags --libs libavformat libavcodec libavutil libswscale)

./transcode input.mp4 output.mp4
```

可以用 `ffprobe` 检查输出容器、编码格式和时间戳：

```bash
ffprobe -hide_banner -show_streams -show_format output.mp4
```

若 FFmpeg 构建中没有 H.264 编码器，`avcodec_find_encoder(AV_CODEC_ID_H264)` 会失败。此时需要安装带 H.264 编码能力的 FFmpeg，或把 Demo 的编码器改为当前构建可用的编码器。

### 6.3 按本文结构回看 Demo

```text
第一部分：对象总览
  Pipeline 只负责集中持有对象和清理资源

初始化部分
  init_decoder()
    format → stream/codecpar → decoder context → packet/frame

  init_encoder_and_muxer()
    output format → encoder context → output stream
    → encode frame → AVIO → container header

循环部分
  run_loop()
    av_read_frame → avcodec_send_packet

  receive_and_process_frames()
    avcodec_receive_frame

  convert_and_encode()
    sws_scale → avcodec_send_frame

  receive_and_write_packets()
    avcodec_receive_packet → rescale timestamp → mux

收尾部分
  flush_pipeline()
    flush decoder → flush encoder → write trailer
```

掌握这一结构后，再加入音频、滤镜、硬件解码或网络输入时，仍然可以把新增对象放回同一条依赖链中判断：它在初始化时依赖谁，在循环中接收什么、输出什么，结束时需要怎样冲刷和释放。

---

## 7. 参考资料

- [FFmpeg libavformat 文档](https://ffmpeg.org/doxygen/trunk/group__libavf.html)
- [FFmpeg 解码示例](https://ffmpeg.org/doxygen/trunk/decode_video_8c-example.html)
- [FFmpeg 编码示例](https://ffmpeg.org/doxygen/trunk/encode_video_8c-example.html)
- [FFmpeg 复用示例](https://ffmpeg.org/doxygen/trunk/mux_8c-example.html)
- [FFmpeg scaling_video 示例](https://ffmpeg.org/doxygen/trunk/scaling_video_8c-example.html)
