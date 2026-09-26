---
title: '[嵌入式AI-视频工程] stride、对齐与ROI'
published: 2026-09-24T08:12:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍stride、对齐与ROI的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-2 stride（行跨度）、对齐与ROI（Region of Interest，感兴趣区域）

本节只解决一个问题：**一行有效像素结束后，下一行究竟从哪个地址开始。**

阶段2-1已经说明像素格式决定一行需要多少有效字节。本节在此基础上加入对齐和ROI：缓冲区可以在每行末尾保留padding（填充字节），ROI也可以只引用父图每行中间的一段，因此不能默认整幅图像是一段紧密排列的数据。

## 1 width、有效行数据、stride与padding的地址模型

### 1.1 四个量和两个地址公式

对普通二维packed图像，只需先区分四个量：

- `width`：一行的有效像素数，单位为像素；
- `pixel_size`：一个像素占多少字节；
- `row_bytes`：一行有效像素占多少字节；
- `stride`：当前行起点到下一行起点的距离，单位为字节。

它们的关系一次写清楚：

```text
row_bytes = width × pixel_size
stride    = row_bytes + padding_bytes
```

已知缓冲区首地址`base`后，第`y`行和第`x、y`个像素的地址分别是：

```text
row(y)      = base + y × stride
pixel(x, y) = base + y × stride + x × pixel_size
```

例如宽度为641的BGR888图像，`pixel_size=3`，所以`row_bytes=1923`。若分配器要求每行占用空间按64字节对齐，stride会向上取整为1984字节，每行末尾留下61字节padding：

```text
第0行：[1923字节有效像素][61字节padding]
第1行：[1923字节有效像素][61字节padding]
```

这个例子已经包含本节最重要的区别：`width`决定有效内容，`stride`决定地址移动。

### 1.2 行字节数为什么会补到16、32或64的整数倍

有些设备要求每行占用的字节数必须是某个数的整数倍。例如要求“64字节对齐”，就是stride必须取64、128、192、256……这类数。如果一行实际需要1923字节，就要向上补到下一个64的整数倍1984，多出的61字节就是padding。

需要在程序中计算时，可以把这个要求记作`A`字节：

```text
对齐后的字节数 = ((原字节数 + A - 1) / A) × A
```

但程序不能自行假设摄像头、编解码器、DRM或RGA都要求16、32或64的整数倍。具体要求来自分配器、驱动、硬件型号、像素格式和当前操作，可能限制stride、平面offset、分配高度或ROI坐标。

因此实际工程只遵守两条规则：

1. 自己分配内存时，按目标接口声明的约束计算；
2. 接收别人产生的缓冲区时，使用生产者返回的stride、offset和buffer size，不重新猜测。

padding不属于图像像素。逐行处理或复制有效图像时，每行只处理`row_bytes`，然后分别按源stride和目标stride进入下一行。只有明确需要复制整个硬件布局时，才连同padding和其他附加区域一起处理。

## 2 多平面图像与硬件缓冲区的布局差异

### 2.1 NV12与YUV420P的逐平面stride

阶段2-1已经讲过NV12和YUV420P的格式平面。加入stride后，只需把每个平面当作一张具有独立行跨度的二维数组：

| 格式与平面 | 每行有效字节数 | 有效行数 |
| --- | ---: | ---: |
| NV12的Y平面 | `W` | `H` |
| NV12的UV平面 | `W` | `H/2` |
| YUV420P的Y平面 | `W` | `H` |
| YUV420P的U平面 | `W/2` | `H/2` |
| YUV420P的V平面 | `W/2` | `H/2` |

在没有padding的紧密布局中，关系是确定的：

```text
NV12：     Y stride = UV stride = W字节
YUV420P：  Y stride = W字节
           U stride = V stride = W/2字节 = Y stride/2
```

加入逐平面对齐后，YUV420P的1:2关系可能失效。例如图像宽度为1922，若每个平面的行占用都要补成64的整数倍，Y stride为1984字节，U和V的961个有效字节会各自补到1024字节；此时U/V stride并不等于`1984/2=992`。

因此，每个平面都应使用生产者给出的`data[i]`和`stride[i]`定位，不能从Y stride推算U、V stride。

### 2.2 平面offset、分配高度与buffer size

可见高度也不一定等于实际分配高度。例如摄像头输出1080行，硬件可能按1088行分配Y平面。此时UV平面可能从对齐后的第1088行之后开始，而不是紧跟第1080行。

所以程序不应自行用`Y stride × 可见高度`推导UV起点，而应优先使用生产者给出的：

- 各平面地址；
- 各平面offset；
- 各平面stride；
- 完整buffer size或`sizeimage`。

`stride × 可见高度`也不一定是可提交给硬件的缓冲区大小。硬件可能访问行尾padding，驱动还可能要求对齐后的高度、平面间隔或modifier附加区域。申请、映射和提交缓冲区时必须使用接口给出的完整大小。

### 2.3 RGA的wstride单位与对齐约束

RGA（Raster Graphic Acceleration，光栅图形加速器）是Rockchip平台常用的二维图像处理硬件。当前librga文档中的`rga_buffer_t`使用：

- `width、height`：有效图像宽高，单位为像素；
- `wstride、hstride`：缓冲区宽高方向的步幅，单位也为像素；
- `format`：RGA像素格式。

这里的`wstride`不是通用的byte stride。例如RGB888的`wstride=640`表示一行按640个像素组织，对应的线性字节跨度通常是`640 × 3`；OpenCV的`step`、FFmpeg的`linesize`和DRM的`pitch`则直接以字节为单位。

RGA对齐限制会随硬件代际和格式变化。部分YUV格式会同时限制wstride、hstride以及ROI的`x、y、width、height`。应查询当前平台对应的[Rockchip RGA图像格式对齐说明](https://github.com/airockchip/librga/blob/main/docs/Rockchip_Developer_Guide_RGA_CN.md#图像格式对齐说明)，并在开发阶段使用`imcheck()`和`imStrError()`验证参数；不要从另一款芯片的示例复制对齐常数。[Rockchip RGA FAQ](https://github.com/airockchip/librga/blob/main/docs/Rockchip_FAQ_RGA_CN.md#q311imcheck返回报错该如何处理)

## 3 OpenCV ROI共享父图后为什么可能不连续

### 3.1 ROI只移动data，不重新排列每一行

ROI（Region of Interest，感兴趣区域）通常只是父图的一个视图：OpenCV创建新的`cv::Mat`对象头，让`data`指向ROI左上角，但继续共享父图的像素缓冲区。其起始地址为：

```text
roi.data
= parent.data
+ roi_y × parent.step
+ roi_x × parent.elemSize()
```

ROI的宽度变小了，下一行却仍位于父图下一行的相同横坐标，因此ROI通常保留父图的`step`。

例如父图每行有6个单通道像素，截取中间3列：

```text
父图第1行：[10] [11 12 13] [14 15]
父图第2行：[20] [21 22 23] [24 25]
                 └─ ROI ─┘
```

ROI的正确内容是`11 12 13 / 21 22 23`。但从`roi.data`连续读取6字节会得到`11 12 13 14 15 20`，因为这种读法没有使用父图保留下来的step进入第二行。

### 3.2 `isContinuous()`、逐行访问与深拷贝

`cv::Mat::isContinuous()`表示各行有效数据之间是否没有间隙。OpenCV在构造对象头时维护这个标志，因此应直接查询它，而不是根据“整图”或“ROI”猜测。单行ROI可能连续，包装了外部padding缓冲区的整图也可能不连续。[OpenCV `cv::Mat`文档](https://docs.opencv.org/4.x/d3/d63/classcv_1_1Mat.html)

通用访问方法是逐行取得指针：

```cpp
for (int row = 0; row < image.rows; ++row) {
    const std::uint8_t* row_data = image.ptr<std::uint8_t>(row);
    // 只处理当前行的有效元素。
}
```

只有`isContinuous()`为真时，才能把所有有效元素作为一段一维数组遍历。

如果下游接口明确要求连续输入，可以调用`clone()`或`copyTo()`生成新的紧密缓冲区。这样做会真实复制像素，不能仅为了让循环写起来方便就在每帧调用。ROI共享和深拷贝的所有权语义已在阶段1-3第4节解释，这里不再重复。

## 4 YUV 4:2:0格式的ROI坐标与色度采样边界

阶段2-1第2.2节已经说明，YUV 4:2:0通常由一个2×2亮度块共享一组U、V样本。若ROI从奇数坐标开始，边界就会穿过共享色度样本；若宽高为奇数，右侧或底部也无法由完整的2×2块覆盖。

因此NV12、NV21和YUV420P进行零拷贝裁剪时，常见要求是`x、y、width、height`为偶数。具体API可能拒绝参数、调整边界、共享相邻色度，或者重新采样生成新图，最终应以消费者接口和硬件约束为准。

还不能把一块NV12内存简单包装成`(H × 3/2) × W`的单通道`cv::Mat`，再用普通`Rect`完成语义上的图像裁剪。Y与UV具有不同的坐标尺度，正确的零拷贝ROI必须分别计算两个平面的起点、尺寸和stride，或者使用明确支持NV12裁剪的接口。

## 5 OpenCV、FFmpeg、V4L2、DRM与RGA的字段对应关系

这些接口解决的是同一类布局问题，但字段单位和描述对象不同。前面的地址模型不需要再讲一遍，只需记录差异：

| 接口 | 行跨度字段 | 单位 | 需要同时保留的信息 |
| --- | --- | --- | --- |
| OpenCV `cv::Mat` | `step` | 字节 | `rows、cols、type、data` |
| FFmpeg `AVFrame` | `linesize[i]` | 字节 | `format、data[i]、width、height` |
| V4L2单平面API | `bytesperline` | 字节 | `pixelformat、sizeimage、width、height` |
| V4L2多平面API | `plane_fmt[i].bytesperline` | 字节 | 各plane的`sizeimage`和映射信息 |
| DRM framebuffer | `pitches[i]` | 字节 | `handles[i]、offsets[i]、modifier、FourCC` |
| Rockchip RGA | `wstride、hstride` | 像素 | `width、height、format` |

FFmpeg允许`linesize[i]`为负数表示图像行反向存放，也允许其大于有效行数据以容纳padding。[FFmpeg `AVFrame`文档](https://ffmpeg.org/doxygen/trunk/structAVFrame.html)

V4L2驱动可以返回大于理论值的`bytesperline`，采集硬件还可能访问padding，因此缓冲区应按驱动返回的`sizeimage`准备。[V4L2单平面格式文档](https://docs.kernel.org/userspace-api/media/v4l/pixfmt-v4l2.html) 多平面API则为每个memory plane分别提供布局信息。[V4L2多平面格式文档](https://docs.kernel.org/userspace-api/media/v4l/pixfmt-v4l2-mplane.html)

DRM的`pitches[i]`和`offsets[i]`按照FourCC规定的格式平面顺序填写，同一个GEM handle可以被多个平面复用。[DRM `drm_mode_fb_cmd2`](https://docs.kernel.org/next/gpu/drm-uapi.html#c.drm_mode_fb_cmd2)

跨模块传递图像时，不能只传地址或DMA-BUF fd。消费者还需要宽高、像素格式、逐平面stride和offset；涉及硬件布局时还需要modifier等信息。

## 6 stride、offset与ROI错误的现象及排查方法

几个常见现象可以直接对应到地址错误：

- 第一行正确，后续逐渐倾斜：进入下一行时用了错误的stride；
- NV12亮度正常但颜色出现横条：UV stride或UV offset错误；
- ROI第一行正确，第二行混入父图其他列：把非连续ROI当作一维数组；
- RGA报告YUV not align：当前格式的wstride、hstride或ROI坐标不满足硬件约束；
- V4L2缓冲区越界：按理论帧大小分配，忽略了驱动返回的`sizeimage`；
- DRM提交失败：pitch、offset、modifier或格式组合不被目标plane接受。

排查时按数据的生产顺序检查：

```text
记录生产者返回的格式、宽高、stride、offset和buffer size
→ 打印前两行实际地址并计算地址差
→ 对ROI打印data、step、cols×elemSize()和isContinuous()
→ 检查传给下游时是否丢字段、改单位或自行重算
→ 最后使用驱动日志、RGA imcheck或DRM test-only定位硬件约束
```

## 7 非连续ROI的错误扁平遍历与逐行访问Demo

这个Demo只验证一个结论：ROI的`data`指向首个有效像素，但后续`rows × cols`个元素不一定连续属于ROI。

程序使用C++17和OpenCV核心模块。`CV_8UC1`表示每个元素是一个8位无符号单通道值；`cv::Rect(x, y, width, height)`创建ROI；`ptr<std::uint8_t>(row)`根据矩阵step返回指定行的首地址。

```cpp
#include <cstdint>
#include <iostream>

#include <opencv2/core.hpp>

// 从data开始连续读取image.total()个元素。
// 这个操作本身不会使用step，只有image.isContinuous()为true时才代表全部有效元素。
void printFlatBytesWithoutChecking(const cv::Mat& image) {
    std::cout << "从data连续读取：";
    for (std::size_t index = 0; index < image.total(); ++index) {
        std::cout << static_cast<int>(image.data[index]) << ' ';
    }
    std::cout << '\n';
}

// 正确访问任意二维CV_8UC1矩阵：每行通过ptr(row)按step重新定位。
// image只被读取，函数不拥有其缓冲区，也不会把行指针保存到image生命周期之外。
void printByRows(const cv::Mat& image) {
    std::cout << "按step逐行读取：";
    for (int row = 0; row < image.rows; ++row) {
        const std::uint8_t* row_data = image.ptr<std::uint8_t>(row);
        for (int col = 0; col < image.cols; ++col) {
            std::cout << static_cast<int>(row_data[col]) << ' ';
        }
    }
    std::cout << '\n';
}

int main() {
    // parent持有4×6的连续缓冲区，每行写入可辨认的row*10+col。
    cv::Mat parent(4, 6, CV_8UC1);
    for (int row = 0; row < parent.rows; ++row) {
        std::uint8_t* row_data = parent.ptr<std::uint8_t>(row);
        for (int col = 0; col < parent.cols; ++col) {
            row_data[col] = static_cast<std::uint8_t>(row * 10 + col);
        }
    }

    // ROI正确内容为11 12 13 / 21 22 23。
    // 它共享parent缓冲区，data指向11，step仍保留父图的6字节。
    cv::Mat roi = parent(cv::Rect(1, 1, 3, 2));

    std::cout << "roi.step=" << roi.step
              << ", roi.isContinuous()=" << roi.isContinuous() << '\n';

    // 本例的错误连续读取仍落在parent已分配区域内，所以能稳定显示逻辑错误；
    // 对其他ROI照搬这种访问方式可能越界。
    printFlatBytesWithoutChecking(roi);
    printByRows(roi);

    // clone只复制ROI的有效像素，compact拥有新的连续缓冲区。
    cv::Mat compact = roi.clone();
    std::cout << "compact.step=" << compact.step
              << ", compact.isContinuous()=" << compact.isContinuous() << '\n';
    printFlatBytesWithoutChecking(compact);

    return 0;
}
```

Linux安装OpenCV开发包并提供`opencv4.pc`后，可以直接编译：

```bash
g++ -std=c++17 -Wall -Wextra roi_stride_demo.cpp \
  $(pkg-config --cflags --libs opencv4) \
  -o roi_stride_demo

./roi_stride_demo
```

预期输出为：

```text
roi.step=6, roi.isContinuous()=0
从data连续读取：11 12 13 14 15 20
按step逐行读取：11 12 13 21 22 23
compact.step=3, compact.isContinuous()=1
从data连续读取：11 12 13 21 22 23
```

第一种读取在ROI第一行结束后继续进入父图剩余列；逐行版本使用step直接到达第二行ROI起点；`clone()`则把两行有效数据重新排成连续缓冲区。
