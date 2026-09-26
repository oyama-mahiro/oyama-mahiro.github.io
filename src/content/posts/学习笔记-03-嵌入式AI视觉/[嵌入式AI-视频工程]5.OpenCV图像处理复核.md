---
title: '[嵌入式AI-视频工程] OpenCV图像处理复核'
published: 2026-09-24T08:14:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍OpenCV图像处理复核的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-5 OpenCV图像处理复核

## 1 这一阶段要解决什么问题

OpenCV（Open Source Computer Vision Library，开源计算机视觉库）提供了常用的图像变换和分析函数。本节跳过`cv::Mat`内存结构的重复介绍，集中复核拿到一帧图像之后最常用的一条处理路径：

```text
确认输入尺寸、类型和颜色格式
→ 根据目的选择裁剪、缩放或几何变换
→ 根据数据含义选择插值、滤波和阈值方法
→ 保留ROI、缩放和变换产生的坐标关系
→ 检查中间图、最终图和单帧耗时
```

`cv::Mat`的浅拷贝、ROI共享和`step`已经分别在阶段1-3第3～5节、阶段2-2第3节解释。这里直接使用这些结论，不再重复推导内存地址。

## 2 调用OpenCV前先检查图像信息

图像处理接口不会替应用判断“这块内存究竟是什么格式”。调用接口前，应用需要先明确输入的尺寸、通道、像素深度和颜色格式；否则接口即使成功返回，结果也可能没有意义。

### 2.1 尺寸、通道、深度与颜色格式

对一幅二维`cv::Mat`，最常检查以下信息：

```cpp
void printImageInfo(const cv::Mat& image) {
    // cols是宽度，rows是高度；二者的单位都是像素。
    std::cout << "size=" << image.cols << "x" << image.rows
              << ", channels=" << image.channels()
              << ", depth=" << image.depth()
              << ", type=" << image.type()
              << ", step=" << image.step
              << ", continuous=" << image.isContinuous()
              << '\n';
}
```

- `cols`、`rows`：当前矩阵的宽度和高度。
- `channels()`：每个像素包含几个通道。
- `depth()`：单个通道的数据类型，例如`CV_8U`或`CV_32F`。
- `type()`：深度与通道数的组合，例如`CV_8UC3`。
- `step`：相邻两行起始地址相差的字节数，详细含义见阶段2-2第1节。

`CV_8UC3`只能说明“每个像素有三个8位无符号通道”，不能说明三个通道是BGR、RGB还是其他含义。颜色格式来自生产者与消费者之间的约定，不能仅由`cv::Mat::type()`推断。

### 2.2 cvtColor、convertTo和resize的区别

这三个函数改变的是不同属性：

| 函数 | 改变的内容 | 不负责的内容 |
| --- | --- | --- |
| `cv::cvtColor()` | 颜色空间或通道排列 | 不负责改变图像宽高 |
| `cv::Mat::convertTo()` | 像素深度，并可按比例缩放数值 | 不理解BGR、RGB或YUV语义 |
| `cv::resize()` | 图像宽高 | 默认保持输入图像的数据类型 |

例如，模型要求`CV_32FC3`的RGB输入时，常见顺序是先把BGR转换成RGB，再把8位整数转换成32位浮点数并缩放到`0～1`：

```cpp
cv::Mat rgb_image;
cv::cvtColor(bgr_image, rgb_image, cv::COLOR_BGR2RGB);

cv::Mat float_image;
// CV_8U的0～255经过1/255缩放后变为CV_32F的0～1。
rgb_image.convertTo(float_image, CV_32F, 1.0 / 255.0);
```

是否需要RGB、浮点数和`0～1`范围，必须以模型的预处理定义为准，不能把上面的顺序当作所有模型的固定要求。

### 2.3 本文与前面阶段的知识边界

本节假定图像已经被正确包装成`cv::Mat`。如果输入来自V4L2的MMAP缓冲区，应用只能在持有该缓冲区期间读取图像；重新`QBUF`后，驱动可以再次让DMA覆盖它，详见阶段2-3第6节。如果需要跨过这个时间边界保存图像，应复制数据或转移明确的缓冲区所有权。

RGB、YUV、NV12和YUYV的存储方式见阶段2-1；stride、YUV平面与ROI边界见阶段2-2。本节只讨论这些输入进入OpenCV操作后应该选择什么接口以及如何检查结果。

## 3 裁剪、缩放、仿射和透视怎么选

裁剪、缩放、仿射变换和透视变换都可能改变画面，但它们解决的问题不同：

- 只需要矩形中的原始像素：使用ROI裁剪。
- 只改变输出宽高：使用`resize()`。
- 需要旋转、平移、缩放或倾斜：使用`warpAffine()`。
- 需要校正平面物体的透视形变：使用`warpPerspective()`。

### 3.1 ROI裁剪及其坐标含义

`cv::Rect(x, y, width, height)`中的`x、y`是ROI左上角在原图中的坐标，`width、height`是ROI尺寸。OpenCV图像坐标以左上角为原点，`x`向右增加，`y`向下增加。

```cpp
// requested_roi可能来自配置文件或检测结果，不能假设它一定落在图像内部。
const cv::Rect image_area(0, 0, image.cols, image.rows);
const cv::Rect valid_roi = requested_roi & image_area;

if (valid_roi.empty()) {
    throw std::runtime_error("ROI与图像没有交集");
}

// cropped与image共享像素；修改cropped会修改原图对应区域。
cv::Mat cropped = image(valid_roi);
```

矩形求交把ROI限制在图像范围内，避免OpenCV因越界矩形抛出异常。ROI是否共享像素、何时需要`clone()`已经在阶段1-3第4节说明。

### 3.2 resize改变了哪些信息

`resize()`生成指定宽高的新图像。常用形式为：

```cpp
cv::resize(source, destination, output_size, 0.0, 0.0, interpolation);
```

- `source`：输入图像。
- `destination`：输出图像，OpenCV根据需要分配其像素缓冲区。
- `output_size`：输出的`width、height`。
- 两个`0.0`：因为已经明确给出输出尺寸，不再使用横向和纵向缩放因子。
- `interpolation`：插值方式，第4节详细说明。

如果原图宽高为`source_width、source_height`，目标宽高为`destination_width、destination_height`，坐标缩放关系为：

```text
destination_x = source_x × destination_width  / source_width
destination_y = source_y × destination_height / source_height
```

把目标图中的点恢复到原尺寸时使用反向比例。需要注意，横纵缩放比例不相等时，画面会被拉伸。模型要求固定尺寸且不能接受形变时，需要使用等比例缩放加填边，避免把任意宽高直接压成目标尺寸。

### 3.3 warpAffine的2×3矩阵

仿射变换（affine transformation）可以表示平移、旋转、缩放和倾斜。OpenCV使用一个`2×3`矩阵：

```text
[ x' ]   [ a00 a01 a02 ] [ x ]
[ y' ] = [ a10 a11 a12 ] [ y ]
                              [ 1 ]
```

其中`(x, y)`是输入点，`(x', y')`是变换后的点。旋转图像时不必手写矩阵，可以先调用`getRotationMatrix2D()`：

```cpp
const cv::Point2f center(image.cols / 2.0F, image.rows / 2.0F);
// angle_degrees单位是度；正值表示逆时针旋转。scale=1.0表示不额外缩放。
const cv::Mat transform = cv::getRotationMatrix2D(center, angle_degrees, 1.0);

cv::Mat rotated;
cv::warpAffine(image, rotated, transform, image.size(),
               cv::INTER_LINEAR, cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0));
```

这里把输出尺寸设成原图尺寸，所以旋转后的四角可能落到输出范围外并被裁掉。要完整保留旋转后的图像，需要先计算旋转后边界，再扩大输出尺寸并修正矩阵中的平移量。

### 3.4 warpPerspective的3×3矩阵

透视变换（perspective transformation）用于把一个平面上的四边形映射到另一个四边形，例如把斜拍的纸张校正为俯视矩形。它使用`3×3`矩阵，可以表示仿射变换无法表示的远近缩放差异。

```cpp
#include <array>

std::array<cv::Point2f, 4> source_points = {
    cv::Point2f(120.0F, 80.0F),
    cv::Point2f(520.0F, 110.0F),
    cv::Point2f(560.0F, 390.0F),
    cv::Point2f(90.0F, 370.0F)
};

std::array<cv::Point2f, 4> destination_points = {
    cv::Point2f(0.0F, 0.0F),
    cv::Point2f(399.0F, 0.0F),
    cv::Point2f(399.0F, 299.0F),
    cv::Point2f(0.0F, 299.0F)
};

// 两组点必须按同一方向一一对应，例如都按左上、右上、右下、左下排列。
const cv::Mat transform = cv::getPerspectiveTransform(source_points.data(),
                                                       destination_points.data());

cv::Mat corrected;
cv::warpPerspective(image, corrected, transform, cv::Size(400, 300));
```

点的顺序不一致时，程序通常不会报“点序错误”，而会输出翻转、交叉或严重扭曲的图像。这里掌握输入点、目标点、矩阵和输出尺寸之间的关系即可；如何从视频帧估计运动留到电子稳像阶段。

### 3.5 输出尺寸与边界填充

`warpAffine()`和`warpPerspective()`不会根据变换后的内容自动扩大画布，`dsize`参数直接决定输出矩阵的宽高。对每个输出像素，OpenCV需要找到输入图像中的采样位置；位置落到输入范围外时，由`borderMode`决定如何处理。

常用选择是：

- `BORDER_CONSTANT`：使用固定颜色填充，默认是黑色。
- `BORDER_REPLICATE`：使用最靠近边界的像素填充。

默认情况下，应用传入通常理解为“输入坐标到输出坐标”的矩阵，OpenCV内部会通过反向查找完成采样；只有显式设置`WARP_INVERSE_MAP`时，矩阵才按“输出坐标到输入坐标”解释。OpenCV当前几何变换接口和矩阵尺寸可查阅[官方几何变换文档](https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html)。

## 4 插值方式为什么不能随便选

几何变换得到的采样位置经常带有小数，例如输入位置为`(10.3, 20.7)`。插值就是根据周围已有像素计算该位置输出值的方法。选择插值方式时，首先判断数据是连续变化的普通图像，还是只能取离散编号的掩码或标签。

### 4.1 最近邻、线性、区域和三次插值

| 插值方式 | 计算特点 | 常见用途 |
| --- | --- | --- |
| `INTER_NEAREST` | 直接选择最近的一个像素，不计算中间值 | 二值掩码、类别标签、最快速预览 |
| `INTER_LINEAR` | 使用邻近`2×2`像素计算结果 | 普通图像的常用默认选择 |
| `INTER_AREA` | 缩小时根据像素区域关系计算结果 | 普通图像缩小 |
| `INTER_CUBIC` | 使用邻近`4×4`像素计算结果 | 对放大质量要求较高且允许更高耗时 |

脱离输入尺寸、处理器和OpenCV构建方式后，没有通用的固定耗时比例。应在目标板上测量自己的分辨率和调用路径，不要照搬其他平台的倍数。

### 4.2 普通图像缩小与放大的选择

普通彩色图像缩小时优先尝试`INTER_AREA`；放大时先尝试速度较快的`INTER_LINEAR`，质量不足且耗时允许时再比较`INTER_CUBIC`。这只是起始选择，最终以输出效果和目标板耗时为准。OpenCV官方`resize()`说明也将`INTER_AREA`列为缩小的常用选择，将`INTER_LINEAR`和较慢的`INTER_CUBIC`列为放大的常见选择。

大幅缩小图像时，如果只是间隔取一个像素，细线或重复纹理容易形成锯齿和摩尔纹；区域插值会综合被压缩区域内的像素，通常更稳定。放大时没有新的真实细节，插值只能让像素过渡更平滑，不能恢复相机没有采集到的细节。

### 4.3 二值掩码和类别标签为什么使用最近邻

假设语义分割标签中只有`0、1、2`三个类别。线性插值会混合相邻类别的数值，产生原来不存在的中间值。即使最终又转换成整数，取整也会任意改变边界附近的类别。

因此，缩放以下数据时使用`INTER_NEAREST`：

- 每个像素只允许为`0`或`255`的二值掩码。
- 每个像素保存类别编号的标签图。
- 像素值保存离散ID、不表达亮度或颜色的图像。

普通相机图像的像素值可以进行平滑估计，类别编号不可以，这是两类插值选择的根本边界。

### 4.4 如何同时比较效果和耗时

比较插值方式时固定输入图像和输出尺寸，对同一操作重复多次，并在目标板的发布构建中测量。首次调用可能包含线程池、缓存或内部初始化开销，不能只测一次就下结论。下面的计时使用C++标准库`<chrono>`中的单调时钟。

```cpp
const auto begin = std::chrono::steady_clock::now();

for (int iteration = 0; iteration < 100; ++iteration) {
    cv::resize(source, destination, output_size, 0.0, 0.0, cv::INTER_AREA);
}

const auto end = std::chrono::steady_clock::now();
const double average_ms =
    std::chrono::duration<double, std::milli>(end - begin).count() / 100.0;
```

`steady_clock`不会因系统时间校准而倒退，适合计算耗时。结果要连同输入尺寸、输出尺寸、图像类型、循环次数和目标硬件一起记录，否则不同测试之间无法比较。

## 5 颜色转换与数据类型检查

### 5.1 BGR和RGB为什么经常弄反

OpenCV通过`imread()`读入的普通三通道彩色图通常是BGR顺序，而很多神经网络示例要求RGB顺序。二者都可以用`CV_8UC3`表示，所以只检查通道数发现不了错误。

```cpp
cv::Mat rgb_image;
cv::cvtColor(bgr_image, rgb_image, cv::COLOR_BGR2RGB);
```

`COLOR_BGR2RGB`表示输入是BGR、输出是RGB。转换方向必须与真实输入一致；不能因为目标是灰度图，就随意在`COLOR_BGR2GRAY`和`COLOR_RGB2GRAY`之间选择。

### 5.2 GRAY、NV12和YUYV的转换入口

`GRAY`表示单通道灰度图。BGR转灰度常写为：

```cpp
cv::cvtColor(bgr_image, gray_image, cv::COLOR_BGR2GRAY);
```

NV12和YUYV都属于YUV格式，但存储方式不同：

- NV12是Y平面加UV交错平面，属于YUV 4:2:0。
- YUYV把`Y0 U0 Y1 V0`交错保存在同一数据流中，属于YUV 4:2:2。

因此它们使用不同的颜色转换代码。两平面分别包装的NV12可以使用`cvtColorTwoPlane()`；YUYV则使用与其打包顺序匹配的`COLOR_YUV2BGR_YUY2`等转换代码。具体平面尺寸、stride和有效范围必须来自采集或解码接口，不能仅按`width × height × 3 / 2`猜测。OpenCV当前支持的转换代码见[官方颜色转换文档](https://docs.opencv.org/4.x/d8/d01/group__imgproc__color__conversions.html)。

### 5.3 通道数量、像素深度和数值范围

像素深度和数值范围是两个概念。把`CV_8U`转换成`CV_32F`只改变存储类型；是否同时从`0～255`缩放到`0～1`取决于`convertTo()`的比例参数。

```cpp
cv::Mat float_0_to_255;
byte_image.convertTo(float_0_to_255, CV_32F);

cv::Mat float_0_to_1;
byte_image.convertTo(float_0_to_1, CV_32F, 1.0 / 255.0);
```

两幅输出都是`CV_32F`，但数值范围不同。某些非线性颜色转换会依赖约定的浮点范围；神经网络预处理还可能要求减均值、除标准差。数值范围应由当前接口或模型定义确定，不能根据“浮点图一般都是`0～1`”进行猜测。

### 5.4 颜色错误的排查方法

颜色异常时按生产路径逐段检查：

1. 打印V4L2、FFmpeg或图像文件解码器返回的真实格式。
2. 打印进入`cvtColor()`前的尺寸、类型和通道数。
3. 对B、G、R差异明显的测试图保存转换前后结果。
4. 检查转换代码的输入格式是否与上游一致。
5. 如果YUV亮度正常但颜色错乱，再检查UV顺序、平面offset和stride。

红蓝互换通常指向BGR/RGB顺序错误；整幅图偏绿或出现彩色横条更可能与YUV转换代码、UV顺序或平面布局有关。这两类问题不要混在一起排查。

## 6 根据噪声类型选择滤波方法

滤波的作用是抑制不希望保留的局部变化，但也会损失真实细节。选择滤波器前先观察噪声表现以及后续操作需要保留什么，不要直接增大卷积核。

### 6.1 均值滤波与高斯滤波

均值滤波让窗口内像素使用相同权重，接口为`blur()`。高斯滤波让距离中心更近的像素权重更高，接口为`GaussianBlur()`。对相机图像做轻度平滑后再二值化时，高斯滤波通常是更常用的起点。

```cpp
// 5×5表示每个输出像素参考周围5行×5列的区域。
// 两个sigma传0时，OpenCV根据核尺寸计算高斯标准差。
cv::GaussianBlur(gray_image, blurred_image, cv::Size(5, 5), 0.0, 0.0);
```

常用方形核尺寸为`3×3`或`5×5`。核越大，参与计算的邻域越大，噪声和小细节都会被更强地平滑，计算量也会上升。

### 6.2 中值滤波适合什么噪声

中值滤波把邻域中的像素排序，使用中间值替换中心像素。它对少量像素突然变成极亮或极暗的椒盐噪声比较有效。

```cpp
// ksize=5表示使用5×5邻域；常用核尺寸必须是大于1的奇数。
cv::medianBlur(source, destination, 5);
```

中值滤波主要用于抑制椒盐噪声，不能把“保留边缘”当作它在所有输入上的固定效果。如果输入主要是连续的随机噪声，高斯滤波可能更合适；如果图像中细小结构本来就是目标，中值滤波也可能把它们删除。

### 6.3 双边滤波的效果与性能代价

双边滤波（bilateral filter）同时考虑像素的空间距离和颜色差异。相距较近且颜色相似的像素更容易互相平滑，跨越明显边缘的像素影响较小，因此它能在平滑区域的同时尽量保留边缘。

```cpp
// d是邻域直径；sigmaColor控制多大颜色差异仍参与平滑；
// sigmaSpace控制多远的像素仍产生明显影响。
cv::bilateralFilter(source, destination, 7, 50.0, 50.0);
```

它需要同时计算空间和颜色权重，通常比均值、高斯和中值滤波更慢。是否能进入实时视频主路径，必须用目标分辨率在目标板上测量。OpenCV对这些滤波器的接口定义见[官方图像滤波文档](https://docs.opencv.org/4.x/d4/d86/group__imgproc__filter.html)。

### 6.4 卷积核尺寸为什么不能一味增大

扩大卷积核会同时产生三个结果：参与计算的邻域变大、局部变化被更强地抑制、单帧计算量增加。噪声减少不等于任务效果一定提高，因为边缘、细线和小目标也可能被抹掉。

实际选择时从`3×3`开始，对同一帧保存处理结果，再比较`5×5`。如果后续是轮廓提取，要观察目标边界是否仍闭合、小目标是否仍存在；如果后续是神经网络，还要比较最终模型输出，而不能只凭人眼认为图像“更干净”。

## 7 从灰度图到轮廓的完整处理链

这一部分只处理一条流程：

```text
灰度图
→ 阈值生成二值图
→ 腐蚀或膨胀清理白色区域
→ findContours沿区域边界追踪
→ 得到有顺序的轮廓坐标
```

### 7.1 阈值把灰度图分成前景和背景

阈值是一个分界数值。对于8位灰度图，`THRESH_BINARY`执行：

```text
灰度值 > threshold：输出255
灰度值 ≤ threshold：输出0
```

例如阈值为120：

```text
输入： 35  80 121 180
输出：  0   0 255 255
```

输出只有0和255，因此称为二值图。本文规定0是背景，255是前景。

```cpp
cv::threshold(gray_image, binary_image,
              120,                  // 分界值
              255,                  // 前景值
              cv::THRESH_BINARY);
```

固定阈值适合光照稳定的图像。Otsu方法会统计0～255的灰度直方图，尝试不同分界值，然后选择能让两组灰度区分最明显的值：

```cpp
const double selected_threshold =
    cv::threshold(gray_image, binary_image,
                  0, 255,
                  cv::THRESH_BINARY | cv::THRESH_OTSU);
```

`selected_threshold`是Otsu选出的全局阈值。自适应阈值会根据每个像素周围的局部平均灰度生成局部阈值，适合亮度分布不均匀的图像。

### 7.2 腐蚀、膨胀、开运算和闭运算

腐蚀和膨胀都是滑动窗口运算。以`3×3`矩形窗口为例：

```text
1 1 1
1 1 1
1 1 1
```

窗口依次对准图像中的每个像素，并读取对应的9个输入值：

```text
腐蚀：输出值 = 3×3窗口内的最小值
膨胀：输出值 = 3×3窗口内的最大值
```

对于0/255二值图：

- 腐蚀窗口中只要出现0，输出就是0，因此白色区域缩小。
- 膨胀窗口中只要出现255，输出就是255，因此白色区域扩大。

一维例子同样能看出结果。窗口宽度为3，图像外部按0处理：

```text
输入：  0   0 255 255 255   0   0
腐蚀：  0   0   0 255   0   0   0
膨胀：  0 255 255 255 255 255   0
```

OpenCV中的窗口称为结构元素。结构元素中的非零位置参与最小值或最大值计算：

```cpp
const cv::Mat kernel = cv::getStructuringElement(
    cv::MORPH_RECT, cv::Size(3, 3));

cv::erode(binary_image, eroded_image, kernel);
cv::dilate(binary_image, dilated_image, kernel);
```

开运算和闭运算是固定组合：

```text
开运算：腐蚀 → 膨胀，用于清除小白点
闭运算：膨胀 → 腐蚀，用于填补小黑洞或连接小断口
```

```cpp
cv::morphologyEx(binary_image, cleaned_image,
                 cv::MORPH_CLOSE, kernel);
```

核越大，白色区域收缩或扩张的范围越大。过大的闭运算核会把相邻目标连接成同一片前景。

### 7.3 边缘与轮廓的区别和联系

**边缘**表示图像中亮度或颜色发生明显变化的位置，常见输出形式是一幅边缘图。

**轮廓**是沿一个连通前景区域边界排列的坐标序列，C++中一条轮廓保存为`std::vector<cv::Point>`。

二值图中的前景边界像素使用一句话判断：

> 一个非零像素周围只要存在0，它就是边界像素。

这里的“周围”指8个相邻位置：

```text
左上  上  右上
 左  当前  右
左下  下  右下
```

两者的关系为：

```text
边缘图：保存哪些像素位于明显变化处
轮廓点：把相连的边界像素整理成有顺序的坐标
```

边缘图经过二值化后可以交给`findContours()`。本文当前流程直接从阈值生成的白色区域提取轮廓，因此不需要额外计算边缘图。

### 7.4 findContours沿8邻域追踪轮廓

`findContours()`接收`CV_8UC1`单通道图，0表示背景，非零值表示前景。它按下面的顺序工作：

```text
逐行从左向右扫描
→ 发现0变成非零的位置
→ 将当前非零像素作为外轮廓起点
→ 在当前点周围的8个邻居中寻找下一个边界像素
→ 沿边界移动并记录坐标
→ 回到起始边界状态
→ 继续逐行扫描下一条轮廓
```

水平扫描只负责寻找轮廓起点。找到起点后，算法可以沿水平、垂直和对角线共8个方向移动，无需再执行一次垂直扫描。

例如：

```text
0 0 0 0 0
0 A B C 0
0 H 1 D 0
0 G F E 0
0 0 0 0
```

中心的`1`周围全部是前景，因此属于内部像素。`A～H`都与0相邻，因此属于边界像素。追踪顺序可以是：

```text
A → B → C → D → E → F → G → H → A
```

OpenCV会在内部工作图中标记已经处理的边界，避免后续扫描重复生成同一条轮廓。

```cpp
std::vector<std::vector<cv::Point>> contours;
std::vector<cv::Vec4i> hierarchy;

cv::findContours(cleaned_image, contours, hierarchy,
                 cv::RETR_EXTERNAL,
                 cv::CHAIN_APPROX_SIMPLE);
```

参数的作用为：

- `RETR_EXTERNAL`：只输出最外层轮廓。
- `CHAIN_APPROX_NONE`：保存沿边界经过的连续点。
- `CHAIN_APPROX_SIMPLE`：直线方向不变时省略中间点，矩形通常只保留四个角点。
- `hierarchy`：保存轮廓之间的前后和父子关系。

当前OpenCV 4.x的逐行扫描和8邻域边界追踪流程可在[OpenCV轮廓实现源码](https://github.com/opencv/opencv/blob/4.x/modules/imgproc/src/contours_new.cpp)中核对。

### 7.5 轮廓点用于周长、面积和包围框计算

轮廓把区域边界保存为有顺序的坐标，因此可以直接计算几何信息：

- `arcLength(contour, true)`：累加相邻轮廓点之间的距离，得到闭合轮廓周长。
- `contourArea(contour)`：根据轮廓点围成的多边形计算面积。
- `boundingRect(contour)`：取得最左、最右、最上和最下坐标，生成水平包围框。
- `drawContours()`：把轮廓绘制到图像上。

```cpp
for (const std::vector<cv::Point>& contour : contours) {
    const double area = cv::contourArea(contour);
    if (area < minimum_area) {
        continue;  // 小面积轮廓在这里被过滤。
    }

    const double perimeter = cv::arcLength(contour, true);
    const cv::Rect box = cv::boundingRect(contour);

    cv::rectangle(preview, box, cv::Scalar(0, 255, 0), 2);
    std::cout << "perimeter=" << perimeter
              << ", area=" << area << '\n';
}
```

面积的单位是平方像素。图像宽高同时放大2倍时，长度变为2倍，面积变为4倍，因此面积筛选值需要绑定处理分辨率。

### 7.6 ROI中的轮廓坐标与原图坐标

在ROI中执行`findContours()`时，ROI左上角是局部坐标`(0, 0)`。将局部轮廓点恢复到原图坐标时，加上ROI左上角偏移：

```text
global_x = roi.x + local_x
global_y = roi.y + local_y
```

包围框的宽高保持不变，只平移左上角：

```cpp
const cv::Rect local_box = cv::boundingRect(contour);
const cv::Rect global_box(local_box.x + roi.x,
                          local_box.y + roi.y,
                          local_box.width,
                          local_box.height);
```

轮廓来自缩放后的ROI时，先按第3.2节的反向比例恢复尺寸，再加ROI偏移。
## 8 主项目验证：几何变换与传统图像处理

本节把两条处理路径接入已有的采集或解码主项目，不再建立新的独立程序。输入是一帧有效的BGR图像，输出是模型尺寸图像、二值图和绘制轮廓框的预览图。

### 8.1 输入图像及处理目标

主项目传入的`bgr_frame`必须满足：

- 非空。
- 类型为`CV_8UC3`。
- 通道顺序确实是BGR。
- 在整个同步处理函数执行期间，底层缓冲区不会被V4L2、解码器或其他线程覆盖。

如果输入仍是NV12或YUYV，先按阶段2-1的格式定义和本节第5.2节完成转换。不要让一个函数名为`processBgrFrame()`的入口接收含义不明的三通道或YUV数据。

第8.2～8.5节的代码用于同一个现有源文件，需要以下头文件：

```cpp
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include <iostream>
#include <stdexcept>
#include <vector>
```

### 8.2 ROI裁剪与模型输入缩放

下面的函数只负责一件事：把有效ROI缩放成模型输入尺寸。它不负责颜色转换和归一化，因为这些操作是否需要取决于模型定义。

```cpp
// 输入：一帧有效图像、原图坐标系中的请求ROI、模型要求的宽高。
// 输出：独立持有像素缓冲区的缩放图；离开函数后不再依赖原始ROI。
cv::Mat prepareModelInput(const cv::Mat& bgr_frame,
                          const cv::Rect& requested_roi,
                          const cv::Size& model_size) {
    if (bgr_frame.empty() || bgr_frame.type() != CV_8UC3) {
        throw std::invalid_argument("输入必须是非空CV_8UC3图像");
    }
    if (model_size.width <= 0 || model_size.height <= 0) {
        throw std::invalid_argument("模型输入宽高必须大于0");
    }

    const cv::Rect image_area(0, 0, bgr_frame.cols, bgr_frame.rows);
    const cv::Rect valid_roi = requested_roi & image_area;
    if (valid_roi.empty()) {
        throw std::invalid_argument("ROI与输入图像没有交集");
    }

    // roi_view只在本函数中借用原图缓冲区。resize会把结果写入model_input的新缓冲区，
    // 因此返回值离开函数后不依赖roi_view，但仍要保证bgr_frame在resize结束前有效。
    const cv::Mat roi_view = bgr_frame(valid_roi);
    cv::Mat model_input;
    cv::resize(roi_view, model_input, model_size, 0.0, 0.0, cv::INTER_AREA);
    return model_input;
}
```

如果ROI可能小于模型输入尺寸，应根据实际缩放方向选择插值，不能无条件使用`INTER_AREA`。主项目可以根据`model_size.area()`与`valid_roi.size().area()`判断起始方案，再在目标板上比较。

### 8.3 灰度、滤波、阈值和形态学

下面的函数把BGR ROI转换为清理后的二值图。Otsu阈值负责从当前灰度分布选择全局阈值，闭运算用于填补白色目标中的小黑洞。

```cpp
// 输入：CV_8UC3的BGR ROI，只读借用其缓冲区。
// 输出：CV_8UC1二值图，像素值为0或255，并独立持有输出缓冲区。
cv::Mat buildBinaryMask(const cv::Mat& bgr_roi) {
    if (bgr_roi.empty() || bgr_roi.type() != CV_8UC3) {
        throw std::invalid_argument("buildBinaryMask要求非空CV_8UC3输入");
    }

    cv::Mat gray;
    cv::cvtColor(bgr_roi, gray, cv::COLOR_BGR2GRAY);

    cv::Mat blurred;
    cv::GaussianBlur(gray, blurred, cv::Size(5, 5), 0.0);

    cv::Mat binary;
    const double selected_threshold =
        cv::threshold(blurred, binary, 0, 255,
                      cv::THRESH_BINARY | cv::THRESH_OTSU);
    std::cout << "Otsu threshold=" << selected_threshold << '\n';

    const cv::Mat kernel = cv::getStructuringElement(
        cv::MORPH_RECT, cv::Size(3, 3));

    cv::Mat cleaned;
    cv::morphologyEx(binary, cleaned, cv::MORPH_CLOSE, kernel);
    return cleaned;
}
```

这条流程假设目标比背景亮。如果实际目标较暗，应考虑`THRESH_BINARY_INV | THRESH_OTSU`。前景方向选错后，继续增加形态学操作无法修正这一语义错误。

### 8.4 轮廓筛选与结果绘制

下面的函数在ROI二值图中查找轮廓，将合格包围框恢复到原图坐标，然后绘制到预览图。`preview`是可写输出，函数会直接修改它。

```cpp
// 输入：binary_roi是ROI坐标系下的CV_8UC1二值图；roi_in_frame给出ROI在原图中的位置。
// 输出：函数直接在preview上绘制；返回值是原图坐标系下通过面积筛选的包围框。
std::vector<cv::Rect> drawContoursOnFrame(const cv::Mat& binary_roi,
                                          const cv::Rect& roi_in_frame,
                                          double minimum_area,
                                          cv::Mat& preview) {
    if (binary_roi.empty() || binary_roi.type() != CV_8UC1) {
        throw std::invalid_argument("轮廓输入必须是非空CV_8UC1二值图");
    }
    if (preview.empty() || preview.type() != CV_8UC3) {
        throw std::invalid_argument("预览图必须是非空CV_8UC3图像");
    }
    if (minimum_area < 0.0) {
        throw std::invalid_argument("最小面积不能为负数");
    }

    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(binary_roi, contours,
                     cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);

    std::vector<cv::Rect> accepted_boxes;
    for (const std::vector<cv::Point>& contour : contours) {
        if (cv::contourArea(contour) < minimum_area) {
            continue;  // 小轮廓只被忽略，binary_roi和preview均保持不变。
        }

        const cv::Rect local_box = cv::boundingRect(contour);
        const cv::Rect global_box(local_box.x + roi_in_frame.x,
                                  local_box.y + roi_in_frame.y,
                                  local_box.width,
                                  local_box.height);

        // global_box已经是原图坐标，因此可以直接画到preview上。
        cv::rectangle(preview, global_box, cv::Scalar(0, 255, 0), 2);
        accepted_boxes.push_back(global_box);
    }

    return accepted_boxes;
}
```

这里没有对二值ROI执行缩放，因此只需要加ROI偏移。如果主项目先缩放ROI再提取轮廓，必须先恢复尺度，再加偏移。

### 8.5 中间结果与单帧耗时检查

接入主项目后，在调试构建中保存少量中间图：

```cpp
cv::imwrite("debug_gray.png", gray);
cv::imwrite("debug_binary.png", binary);
cv::imwrite("debug_cleaned.png", cleaned);
cv::imwrite("debug_preview.png", preview);
```

不要在正常视频循环里每帧写文件，磁盘I/O会掩盖真实图像处理耗时。可以每隔固定帧数采样一次，或者只在检测结果异常时保存。

如果现有CMake目标已经使用OpenCV，只需确保链接了当前代码使用的模块。典型写法为：

```cmake
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)
target_link_libraries(your_existing_target PRIVATE ${OpenCV_LIBS})
```

`imgproc`提供颜色转换、缩放、滤波、阈值、形态学和轮廓函数；`imgcodecs`只在需要`imwrite()`保存调试图时使用。发布版本如果不保存图片，可以移除这条调试路径并按项目实际依赖调整模块。

