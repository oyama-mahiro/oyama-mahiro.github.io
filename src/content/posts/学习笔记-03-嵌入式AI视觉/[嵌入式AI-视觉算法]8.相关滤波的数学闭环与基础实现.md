---
title: '[嵌入式AI-视觉算法] 相关滤波的数学闭环与基础实现'
published: 2026-09-24T08:38:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍相关滤波的数学闭环与基础实现的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '计算机视觉', '深度学习']
category: '嵌入式AI-视觉算法'
draft: false
passwordProtected: true
lang: zh_CN
---

# 阶段3-8 相关滤波的数学闭环与基础实现

本篇只解决相关滤波跟踪中的一个核心问题：第一帧已经框住目标，下一帧到来后，程序怎样在旧位置附近找到目标的新位置。

全文沿着下面的因果关系展开：

```text
用户给出第一帧目标框
→ 程序在目标周围建立更大的搜索区域
→ 搜索区域中包含多个可能位置
→ 需要给每个位置计算分数
→ 训练线性滤波器，让正确位置高分、错误位置低分
→ 循环移动产生所有候选位移，所有分数组成响应图
→ DFT把逐位移相关转换成频域逐点运算
→ 高斯核把线性点积扩展为非线性特征相似度
→ 响应峰值给出目标位移
```

## 1 单目标跟踪背景

### 1.1 单目标跟踪的目标与局部运动假设

单目标跟踪（Single Object Tracking，SOT）的输入包括第一帧图像和用户框选的目标矩形，后续每一帧需要输出该目标的新矩形。算法不需要预先知道框内是人、车辆还是其他物体，它只需要保持对这个区域的连续定位。

相邻视频帧的时间间隔通常很短，因此首先采用局部运动假设：目标在下一帧仍位于上一帧目标中心附近。这个假设把“在整张图中寻找目标”缩小成“在旧位置附近寻找目标”。目标移动超过搜索范围时，纯局部跟踪会失败，后续文章中的扩大搜索、重捕获或检测器校正用于处理这种情况。

### 1.2 根据用户框建立更大的搜索区域

用户框描述当前目标中心及其宽高。程序以用户框中心为中心，截取一个更大的搜索区域。扩大部分提供目标移动空间，也提供目标周围的背景信息。

设用户框宽高为 $w$、$h$，Demo05使用正方形搜索区域，其边长为：

$$
S=\max(w,h)\times searchFactor
$$

$searchFactor$ 是搜索区域相对目标最大边的放大倍数。搜索区域太小会漏掉快速运动，过大则会引入更多相似背景，并让固定模型尺寸中的目标占比变小。

以下代码来自Demo05的 `05_image_patch_demo.cpp` 第31—65行和第175—203行。

```cpp
// targetRect：用户框或上一帧目标框，坐标单位为原图像素。
// searchFactor：搜索区域相对目标最大边的扩展倍数。
// targetMaximumSide用于用同一个尺度同时覆盖长目标和宽目标。
const float targetMaximumSide =
    std::max(
        targetRect.width,
        targetRect.height);

// 搜索区域设计为正方形，并保证边长至少为2像素，避免后续缩放得到空图。
const int searchSide =
    std::max(
        2,
        cvRound(
            targetMaximumSide *
            searchFactor));

// 搜索区域与目标框保持同一中心，使零位移对应响应图中心。
const float targetCenterX =
    targetRect.x +
    targetRect.width * 0.5F;

const float targetCenterY =
    targetRect.y +
    targetRect.height * 0.5F;

// 将浮点中心换算成搜索区域左上角整数坐标。
// cvFloor使覆盖范围稳定，边界不足的部分由前面的paddedPatch负责填充。
const int searchX =
    cvFloor(
        targetCenterX -
        searchSide * 0.5F);

const int searchY =
    cvFloor(
        targetCenterY -
        searchSide * 0.5F);

// paddedPatch已经包含边界填充后的搜索图像。
// 所有搜索区域统一缩放到outputSize，保证后续特征图和滤波器尺寸固定。
cv::resize(
    paddedPatch,
    result.patch,
    outputSize,
    0.0,
    0.0,
    cv::INTER_LINEAR);

// 记录“模型输入1像素”对应多少原图像素。
// 响应图位移最终要乘回这两个比例，才能更新原图中的目标框位置。
result.imagePixelsPerPatchX =
    static_cast<float>(result.requestedRect.width) /
    static_cast<float>(outputSize.width);

result.imagePixelsPerPatchY =
    static_cast<float>(result.requestedRect.height) /
    static_cast<float>(outputSize.height);
```

这里有三个不同的空间：原图空间、截取的搜索区域空间和缩放后的模型空间。原图中的搜索边长可以随用户框变化，`result.patch` 始终缩放为 `outputSize`。后续滤波器因此可以保持固定尺寸。

## 2 搜索区域内目标定位算法的选择

搜索区域确定后，程序需要判断目标位于其中哪个位置。常见方法包括模板匹配、光流和相关滤波。

模板匹配保存上一帧图像块，在当前搜索区域的不同位置计算灰度差、归一化相关系数等分数。它容易理解，但原始像素会受到光照、形变和背景变化影响，直接模板也没有主动学习哪些部分容易造成误判。

光流跟踪局部特征点在相邻帧中的移动，适合短时间、小位移和纹理稳定的场景。目标纹理不足、遮挡导致特征点消失或背景特征点混入时，需要额外的点筛选和目标框估计。

相关滤波同样在局部搜索区域中比较多个位置。它先根据第一帧训练一个评分滤波器，让目标居中的位置得到高分，让偏移位置得到低分；然后利用循环结构和DFT一次计算全部位移的分数。这个方法适合需要在CPU上逐帧运行的任意区域跟踪。它仍会受到遮挡、背景污染和尺度变化影响，这些问题将在后续文章处理。

## 3 相关滤波算法的匹配机制

### 3.1 特征图、线性滤波器与相关分数

先只讨论线性滤波器。设搜索区域经过预处理后得到一维特征：

$$
x=[x_0,x_1,\ldots,x_{N-1}]
$$

线性滤波器为：

$$
w=[w_0,w_1,\ldots,w_{N-1}]
$$

两者在一个固定相对位置上的分数是点积：

$$
s=x^Tw=\sum_{n=0}^{N-1}x_nw_n
$$

滤波器 $w$ 给不同特征位置分配不同权重。直接使用原始模板，相当于令 $w=x$；训练滤波器则利用正确和错误位移的期望分数求出 $w$。训练后的权重可以压低容易在背景中重复出现的成分，也可以用负权重抵消错误位置产生的响应。

例如第一帧搜索特征为：

$$
x=[1,2,0]
$$

直接把它当作评分权重时，不同循环位移的分数为 $[5,2,2]$。如果希望三个位置得到 $[1,0,0]$，可以求出：

$$
w=\left[\frac{1}{9},\frac{4}{9},-\frac{2}{9}\right]
$$

这个滤波器会把正确位置保留为1，并将另外两个位置压到0。实际训练使用连续下降的高斯期望响应，周围位置通常不会被强制设为0。

### 3.2 单个相关分数无法表示目标位移

一次点积只能回答“当前排列得到多少分”，无法回答目标向左、向右、向上或向下移动了多少。为了求位移，程序需要改变搜索特征与滤波器的相对位置，并对每一种相对位置分别打分。

一维信号有左右位移，二维特征图有水平和垂直位移。二维情况下，每个候选位移 $(\Delta x,\Delta y)$ 都会产生一个分数。把所有分数按位移坐标排列，就得到响应图。

### 3.3 循环位移矩阵与响应图

仍使用：

$$
x=[1,2,0]
$$

它的三个循环位移为：

$$
x_0=[1,2,0]
$$

$$
x_1=[2,0,1]
$$

$$
x_2=[0,1,2]
$$

把它们按行排列成循环矩阵：

$$
C(x)=
\begin{bmatrix}
1&2&0\\
2&0&1\\
0&1&2
\end{bmatrix}
$$

然后与滤波器相乘：

$$
r=C(x)w
$$

展开后：

$$
r=
\begin{bmatrix}
x_0^Tw\\
x_1^Tw\\
x_2^Tw
\end{bmatrix}
$$

$r[0]$ 表示零位移分数，$r[1]$ 和 $r[2]$ 表示另外两个循环位移的分数。二维特征图沿两个方向循环移动后，结果 $r$ 也成为二维矩阵，这个矩阵称为响应图（response map）。

响应图包含两类信息：

- 响应图坐标表示一个候选位移。
- 该坐标的数值表示滤波器对这个位移的评分。

最大值所在坐标称为响应峰值位置。峰值位置用于估计目标位移，峰值大小用于观察匹配强度。强干扰物也可能形成错误高峰，因此“最大值”只表示当前模型最偏好的候选位置。

### 3.4 训练时预设的高斯期望响应

第一帧训练使用的是完整搜索区域特征。用户框用于确定搜索区域中心、原图尺度、输出框宽高以及标签宽度；进入滤波器公式后，特征矩阵中没有单独的“目标像素”和“背景像素”标记。

初始化时目标位于搜索区域中心，因此人为规定：中心位移得到最高分，离中心越远分数越低。这个预设答案使用二维高斯函数：

$$
y(u,v)=
\exp\left(
-\frac{(u-c_x)^2+(v-c_y)^2}{2\sigma_y^2}
\right)
$$

$c_x,c_y$ 是响应图中心，$\sigma_y$ 控制峰的宽度。标签定义在响应图或特征图坐标中，覆盖的是所有候选位移。它不在原图上分割用户框内部目标。

用户框大小会参与 $\sigma_y$ 的计算。例如Demo03先将目标宽高转换为特征Cell尺度，再乘 `outputSigmaFactor`：

$$
\sigma_y=
\frac{\sqrt{w h}\times outputSigmaFactor}{cellSize}
$$

用户框变大时，标签峰通常更宽；搜索区域相同但用户框大小不同，训练标签仍可能不同，最终模型也可能不同。

以下代码来自Demo03的 `03_gaussian_label_demo.cpp` 第37—89行。

```cpp
/**
 * @brief 生成训练时使用的二维高斯期望响应。
 * @param responseSize 输出响应图的宽高，通常等于相关滤波特征图的空间宽高。
 * @param sigma 高斯标准差，单位为响应图cell；越小则中心峰越窄。
 * @return CV_32F单通道矩阵，中心接近1，离中心越远数值越接近0。
 */
cv::Mat createGaussianLabel(
    const cv::Size& responseSize,
    float sigma)
{
    // 尺寸和sigma非法时立即终止，避免创建空矩阵或发生除零。
    CV_Assert(responseSize.width > 0);
    CV_Assert(responseSize.height > 0);
    CV_Assert(sigma > 0.0F);

    cv::Mat label(responseSize, CV_32F); // 保存每个位移应得到的目标分数。

    // 未发生位移的训练样本位于响应图中心。
    const float centerX = responseSize.width * 0.5F;
    const float centerY = responseSize.height * 0.5F;
    // 预先计算-1/(2*sigma^2)，循环中只需进行乘法。
    const float exponentScale = -0.5F / (sigma * sigma);

    for (int y = 0; y < responseSize.height; ++y)
    {
        float* row = label.ptr<float>(y); // 直接取得当前行指针，逐像素写入结果。
        const float distanceY = static_cast<float>(y) - centerY;

        for (int x = 0; x < responseSize.width; ++x)
        {
            const float distanceX = static_cast<float>(x) - centerX;
            // squaredDistance是当前位置到响应中心的二维平方距离。
            const float squaredDistance =
                distanceX * distanceX + distanceY * distanceY;

            // 代入二维高斯公式，得到该位移对应的期望分数。
            row[x] = std::exp(squaredDistance * exponentScale);
        }
    }

    return label; // 所有循环位移的监督标签组成一张期望响应图。
}
```

## 4 相关滤波使用的特征图

### 4.1 搜索区域统一缩放为固定模型尺寸

原图中的目标可能是 $20\times20$、$100\times100$ 或其他尺寸。经典KCF通常把目标周围搜索区域缩放到固定模型尺寸，再提取固定空间大小的特征图。例如搜索区域统一缩放到 $64\times64$，Cell为 $4\times4$ 像素时，空间特征网格可以是 $16\times16$。

线性KCF中，$16\times16\times C$ 特征对应 $16\times16\times C$ 滤波器，$C$ 为特征通道数。高斯核KCF保存同尺寸模板特征和 $16\times16$ 模型系数。原图搜索区域大小改变时，归一化后的模型几何仍可保持不变。

### 4.2 灰度、HOG与FHOG搜索特征的简单区别

灰度特征保留二维亮度排列，代码简单，适合验证相关滤波主链。目标与背景亮度发生变化时，灰度模板也会明显变化。

方向梯度直方图（Histogram of Oriented Gradients，HOG）先计算像素亮度梯度，再在Cell中统计边缘方向。它更关注轮廓和局部结构，对整体亮度平移的敏感度较低。FHOG在HOG基础上组织有符号方向、无符号方向和归一化能量等多个通道，适合保留二维空间结构并参与相关滤波。本篇只建立这些输入输出概念，完整FHOG构造放在阶段3-9。

### 4.3 特征图对光照和像素变化的削弱作用

灰度特征可以通过减均值、除标准差削弱整体亮度和对比度变化：

$$
x'=\frac{x-\mu}{\max(\sigma,\varepsilon)}
$$

HOG进一步把像素值转换成梯度方向统计。它可以减弱部分光照变化，但无法消除遮挡、严重形变和相似背景。特征负责提供更稳定的输入，滤波器训练负责学习哪些特征排列对应目标居中。

以下代码来自Demo06的 `06_gray_feature_demo.cpp` 第81—133行。

```cpp
// gray8输入为CV_8U灰度图；grayFloat输出为[0,1]范围的CV_32F特征。
cv::Mat grayFloat;
gray8.convertTo(
    grayFloat,
    CV_32F,
    1.0 / 255.0);

// 计算整个搜索区域的灰度均值和标准差，用于削弱整体亮度与对比度变化。
cv::Scalar meanValue;
cv::Scalar standardDeviation;
cv::meanStdDev(
    grayFloat,
    meanValue,
    standardDeviation);

// epsilon_为分母下限；纯色区域标准差接近0时仍能安全归一化。
const double safeStandardDeviation =
    std::max(
        standardDeviation[0],
        static_cast<double>(epsilon_));

// 每个像素减去区域均值，使特征对整体亮度平移更不敏感。
cv::Mat centered;
cv::subtract(
    grayFloat,
    cv::Scalar(meanValue[0]),
    centered);

// 再除以标准差，使不同对比度的搜索区域落在相近数值尺度。
cv::Mat normalized;
centered.convertTo(
    normalized,
    CV_32F,
    1.0 / safeStandardDeviation);
```

### 4.4 HOG中的梯度、方向、Cell与Block基本概念

HOG首先计算水平梯度和垂直梯度：

$$
G_x(x,y)=I(x+1,y)-I(x-1,y)
$$

$$
G_y(x,y)=I(x,y+1)-I(x,y-1)
$$

随后计算梯度幅值与方向：

$$
m=\sqrt{G_x^2+G_y^2}
$$

$$
\theta=\operatorname{atan2}(G_y,G_x)
$$

Cell是局部梯度统计单元。像素根据方向向对应方向箱投票，投票权重主要来自梯度幅值。Block由相邻多个Cell组成，为这些Cell提供局部归一化上下文，使相同边缘在不同局部对比度下得到更接近的描述。相关滤波需要规则的二维网格，因此最终会把归一化结果重新组织为“每个Cell一个多通道特征向量”。

以下代码来自Demo08的 `08_custom_hog_map_demo.cpp` 第394—467行。

```cpp
/**
 * @brief 从固定尺寸的搜索图像中提取自定义HOG特征并施加汉宁窗。
 * @param imageWindow 输入搜索区域，可为灰度图或BGR图，尺寸必须符合提取器配置。
 * @return 包含灰度图、梯度、中间cell直方图、归一化特征和最终加窗特征。
 */
CustomHogResult CustomHogMapExtractor::extract(
    const cv::Mat& imageWindow) const
{
    CustomHogResult result; // result保留中间结果，便于Demo逐步显示和验证。
    result.grayFloat = convertToGrayFloat(imageWindow);

    // x方向一阶差分：突出垂直边缘，输出尺寸与输入灰度图一致。
    cv::Sobel(
        result.grayFloat, result.gradientX,
        CV_32F, 1, 0, 1, 1.0, 0.0,
        cv::BORDER_REPLICATE);

    // y方向一阶差分：突出水平边缘。
    cv::Sobel(
        result.grayFloat, result.gradientY,
        CV_32F, 0, 1, 1, 1.0, 0.0,
        cv::BORDER_REPLICATE);

    // 将(gx, gy)转换为梯度幅值和0~360度方向角；true表示角度单位为度。
    cv::cartToPolar(
        result.gradientX,
        result.gradientY,
        result.magnitude,
        result.angleDegrees,
        true);

    // 将像素梯度按cell和方向bin累加，得到尚未归一化的方向直方图。
    result.rawCellHistograms =
        accumulateCellHistograms(result.magnitude, result.angleDegrees);

    // 使用重叠block对cell直方图归一化，降低局部光照和对比度影响。
    result.normalizedFeature =
        normalizeOverlappingBlocks(result.rawCellHistograms);

    // 对每个特征通道乘同一张汉宁窗，压低循环边界处的不连续特征。
    result.feature = hann_window_demo::applyHannWindow(
        result.normalizedFeature,
        hannWindow_);

    return result; // feature是后续DFT和相关滤波真正使用的多通道特征图。
}
```

### 4.5 汉宁窗对特征图循环边界的处理

DFT在固定长度上计算时采用周期边界，特征图右边会与左边相接，上边会与下边相接。真实搜索图像的两侧通常不连续，直接循环相接会产生强烈的虚假边缘。

汉宁窗（Hann window）中心权重接近1，边缘逐渐下降到0。将特征图逐元素乘窗，可以降低边缘不连续对循环相关的影响。汉宁窗只削弱搜索区域外缘，它不会识别用户框内部哪些像素属于目标。

二维窗可以由两个一维窗的外积得到：

$$
H(x,y)=h_x(x)h_y(y)
$$

以下代码来自Demo04的 `04_hann_window_demo.cpp` 第12—38行和第74—88行。

```cpp
/**
 * @brief 生成CC风格的二维汉宁窗。
 * @param windowSize 窗口宽高，必须与待加窗特征图的空间尺寸一致。
 * @return CV_32F单通道权重图；中心接近1，四周逐渐衰减到0。
 */
cv::Mat createHannWindow(const cv::Size& windowSize)
{
    // 宽高至少为2，汉宁公式才有有效的首尾采样点。
    CV_Assert(windowSize.width > 1);
    CV_Assert(windowSize.height > 1);

    // OpenCV先生成标准二维Hanning权重。
    cv::Mat openCvWindow;
    cv::createHanningWindow(
        openCvWindow,
        windowSize,
        CV_32F);

    // Demo04按CC实现的窗口形状再逐元素平方，使边缘衰减更强。
    return openCvWindow.mul(openCvWindow);
}

// feature为H×W×C多通道特征，hannWindow为H×W单通道权重。
std::vector<cv::Mat> channels;
cv::split(feature, channels); // 拆分通道，便于逐通道乘同一空间窗口。

for (cv::Mat& channel : channels)
{
    // 只改变空间权重，不混合不同方向或不同类型的特征通道。
    cv::multiply(channel, hannWindow, channel);
}

cv::Mat result;
cv::merge(channels, result); // 恢复H×W×C布局，供后续多通道相关使用。
```

## 5 相关滤波所需的数学补充

### 5.1 时域与频域

时域直接记录信号在各个位置上的数值。一维信号的横轴可以是时间或采样位置，二维图像的两个轴是空间坐标。

频域把同一个信号表示成不同频率复指数的组合。低频描述缓慢变化，高频描述快速变化。频域没有丢掉原信号信息；幅值和相位共同保留了重建信号所需的信息。

相关滤波使用频域的原因来自循环结构：时域中大量的循环移动与乘加，可以在频域中转化为相同位置上的逐点运算。

### 5.2 离散傅里叶变换与离散傅里叶逆变换

长度为 $N$ 的离散信号 $x[n]$ 的离散傅里叶变换（Discrete Fourier Transform，DFT）为：

$$
X[k]=\sum_{n=0}^{N-1}x[n]e^{-j2\pi kn/N}
$$

$X[k]$ 是第 $k$ 个频率分量。离散傅里叶逆变换（Inverse Discrete Fourier Transform，IDFT）将频谱恢复为时域信号：

$$
x[n]=\frac{1}{N}\sum_{k=0}^{N-1}X[k]e^{j2\pi kn/N}
$$

二维图像先沿一个方向变换，再沿另一个方向变换，最终得到二维复数频谱。

以下代码来自Demo01的 `01_dft_demo.cpp` 第76—115行。

```cpp
/**
 * @brief 对单通道实数矩阵执行二维离散傅里叶变换。
 * @param image 非空单通道矩阵，整数或浮点类型均可。
 * @return CV_32FC2复数频谱；通道0为实部，通道1为虚部。
 */
cv::Mat forwardDft(const cv::Mat& image)
{
    // DFT输入必须有效，并且本Demo只处理一个实数通道。
    CV_Assert(!image.empty());
    CV_Assert(image.channels() == 1);

    // 统一转换成CV_32F，保证频谱输出类型和后续复数运算一致。
    cv::Mat floatImage;
    image.convertTo(floatImage, CV_32F);

    cv::Mat spectrum;
    cv::dft(
        floatImage,
        spectrum,
        cv::DFT_COMPLEX_OUTPUT); // 强制输出完整的实部/虚部双通道频谱。

    return spectrum;
}

/**
 * @brief 将CV_32FC2二维复数频谱反变换为实数矩阵。
 * @param spectrum forwardDft或等价运算产生的复数频谱。
 * @return CV_32F单通道时域矩阵，尺寸与输入频谱一致。
 */
cv::Mat inverseDft(const cv::Mat& spectrum)
{
    // 类型检查可防止把普通双通道图像误当成复数频谱。
    CV_Assert(!spectrum.empty());
    CV_Assert(spectrum.type() == CV_32FC2);

    cv::Mat restored;
    cv::idft(
        spectrum,
        restored,
        cv::DFT_REAL_OUTPUT | cv::DFT_SCALE); // 只取实数结果，并除以元素总数恢复原幅值。

    return restored;
}
```

`CV_32FC2` 的两个通道分别保存实部和虚部。`DFT_SCALE` 执行 $1/N$ 缩放，保证IDFT恢复原数值范围。

### 5.3 复数频谱与复共轭

复数可以写为：

$$
z=a+jb
$$

它的复共轭为：

$$
\overline z=a-jb
$$

用幅值和相位表示时：

$$
z=|z|e^{j\phi},\qquad
\overline z=|z|e^{-j\phi}
$$

两个频谱做相关时，一个频谱取共轭：

$$
X\overline H
=|X||H|e^{j(\phi_X-\phi_H)}
$$

这里保留的是相位差。信号平移会改变频谱相位，因此相位差能够携带相对位移信息。

### 5.4 频域逐点乘法、共轭乘法与复数除法

频域逐点乘法表示相同频率位置分别相乘：

$$
C[k]=A[k]B[k]
$$

频域相关使用共轭乘法：

$$
C[k]=A[k]\overline{B[k]}
$$

以下代码来自Demo02的 `02_complex_spectrum_demo.cpp` 第62—90行。

```cpp
/**
 * @brief 对两个同尺寸CV_32FC2频谱执行逐频率复数乘法。
 * @param spectrumA 第一个复数频谱。
 * @param spectrumB 第二个复数频谱。
 * @param conjugateB true时先对B取共轭，用于频域相关；false用于频域卷积。
 * @return 与输入同尺寸的CV_32FC2复数频谱。
 */
cv::Mat multiplySpectrums(
    const cv::Mat& spectrumA,
    const cv::Mat& spectrumB,
    bool conjugateB)
{
    // 检查尺寸、类型和通道，避免逐点运算时发生布局不匹配。
    checkSpectrumPair(spectrumA, spectrumB);

    cv::Mat result;
    cv::mulSpectrums(
        spectrumA,
        spectrumB,
        result,
        0,             // flags=0表示按二维频谱处理。
        conjugateB);   // 决定计算A·B还是A·conj(B)。

    return result;
}
```

当 `conjugateB=false` 时计算 $A\odot B$；当 `conjugateB=true` 时计算 $A\odot\overline B$。

两个复数：

$$
p=a+jb,\qquad q=c+jd
$$

其除法为：

$$
\frac{p}{q}
=
\frac{ac+bd}{c^2+d^2}
+j\frac{bc-ad}{c^2+d^2}
$$

以下代码来自Demo02的 `02_complex_spectrum_demo.cpp` 第117—169行。

```cpp
// 设复数分子为a+jb，分母为c+jd；四个矩阵分别保存每个频率点的分量。
const cv::Mat& a = numeratorPlanes[0];
const cv::Mat& b = numeratorPlanes[1];
const cv::Mat& c = denominatorPlanes[0];
const cv::Mat& d = denominatorPlanes[1];

// |c+jd|^2=c^2+d^2是复数除法的公共分母。
cv::Mat commonDenominator = c.mul(c) + d.mul(d);
commonDenominator += epsilon; // 防止频谱能量为0或过小时出现除零和数值爆炸。

// (a+jb)/(c+jd)的实部为(ac+bd)/(c^2+d^2)。
cv::Mat realNumerator = a.mul(c) + b.mul(d);
cv::Mat realResult;
cv::divide(
    realNumerator,
    commonDenominator,
    realResult);

// 虚部为(bc-ad)/(c^2+d^2)。
cv::Mat imaginaryNumerator = b.mul(c) - a.mul(d);
cv::Mat imaginaryResult;
cv::divide(
    imaginaryNumerator,
    commonDenominator,
    imaginaryResult);

// 将实部和虚部重新合并成OpenCV使用的CV_32FC2复数频谱。
cv::Mat result;
cv::merge(
    std::vector<cv::Mat>{realResult, imaginaryResult},
    result);
```

### 5.5 时域卷积与时域相关

先使用两个普通的一维信号：

$$
a=[1,2],\qquad b=[3,4]
$$

线性卷积定义为：

$$
c[k]=\sum_n a[n]b[k-n]
$$

$b[k-n]$ 中的负号表示一个信号在滑动前发生反转。本例结果为：

$$
a*b=[3,10,8]
$$

线性相关的一种定义为：

$$
r[k]=\sum_n a[n]b[n+k]
$$

相关保持信号顺序并改变相对位移。本例在位移 $-1,0,1$ 上的结果为：

$$
r=[6,11,4]
$$

卷积表达一个信号按照另一个信号规定的权重组合后的输出；相关表达两个信号在不同相对位移下的重合程度。不同资料可能交换两个相关输入，使位移正负方向相反。

二维情况把一个位移 $k$ 扩展为水平、垂直位移 $(u,v)$。二维卷积会将其中一个矩阵旋转180度后滑动，二维相关保持矩阵方向并在两个方向上滑动。

### 5.6 时域卷积和相关在频域中的等价计算

卷积定理给出：

$$
\mathcal F(a*b)=A\odot B
$$

所以：

$$
a*b=\mathcal F^{-1}(A\odot B)
$$

相关定理给出：

$$
\mathcal F(a\star b)=A\odot\overline B
$$

所以：

$$
a\star b=
\mathcal F^{-1}(A\odot\overline B)
$$

实际步骤可以压缩为：

```text
卷积：DFT → 两个频谱逐点相乘 → IDFT
相关：DFT → 一个频谱取共轭后逐点相乘 → IDFT
```

未补零的 $N$ 点DFT对应循环卷积和循环相关。若要得到普通线性卷积，需要将两个信号至少补零到 $N_a+N_b-1$。KCF主动使用固定周期域中的循环结构，因此直接采用循环相关。

### 5.7 循环相关与循环位移矩阵乘法的等价关系

第3.3节的时域计算为：

$$
r=C(x)w
$$

其中循环矩阵每一行是搜索特征的一种循环位移，每一行与滤波器点积得到一个分数。

频域计算为：

$$
r=
\mathcal F^{-1}
\left(
X\odot\overline W
\right)
$$

这两条路线结果相同。程序没有在内存中创建 $N\times N$ 循环矩阵；DFT把循环矩阵对角化后，只需对 $N$ 个频率位置逐点运算。IDFT输出 $N$ 个数，每个数仍对应一个循环位移分数。

从直观操作看，可以把它理解为滤波器在特征图上循环移动：每移动一个位置，就与当前排列逐元素相乘并求和。频域公式一次完成了全部移动位置的同类计算。

### 5.8 分母防零项与正则化项

频域训练需要逐频率做除法。如果某个频率位置的分母接近0，模型系数会被放大，并对噪声非常敏感。相关滤波训练通常在分母中加入正则化系数 $\lambda$：

$$
\frac{A[k]}{B[k]+\lambda}
$$

$\lambda$ 同时限制模型参数过大，降低第一帧细节被完全记住的程度。数值实现中的 `epsilon` 只负责防止浮点除零；$\lambda$ 属于训练目标的一部分。二者作用不同。

以下代码来自Demo10的 `10_filter_train_demo.cpp` 第51—68行。

```cpp
/**
 * @brief 给复数核频谱的实部逐点加入正则化系数lambda。
 * @param spectrum 输入CV_32FC2频谱，表示Kxx。
 * @param regularization 正则化系数，必须大于0。
 * @return Kxx+lambda对应的CV_32FC2频谱，输入矩阵保持不变。
 */
cv::Mat addRegularizationToSpectrum(
    const cv::Mat& spectrum,
    float regularization)
{
    // 训练公式要求非空复数频谱和正的lambda。
    CV_Assert(!spectrum.empty());
    CV_Assert(spectrum.type() == CV_32FC2);
    CV_Assert(regularization > 0.0F);

    // planes[0]为实部，planes[1]为虚部。
    std::vector<cv::Mat> planes;
    cv::split(spectrum, planes);

    // lambda是实数，所以只加到每个频率点的实部，虚部保持不变。
    planes[0] += regularization;

    cv::Mat result;
    cv::merge(planes, result);
    return result; // 该结果将作为Alpha频谱求解公式的分母。
}
```

## 6 线性KCF的训练与推理

### 6.1 线性相关滤波器的训练流程

第一帧得到搜索特征 $x$，并生成期望响应 $y$。先采用“检测时让当前特征频谱直接乘以滤波器”的记法。我们希望特征经过滤波器后得到预设响应：

$$
y=x*h
$$

根据卷积定理，它在频域中变成：

$$
Y=X\odot H
$$

如果每个频率位置的 $X[k]$ 都不为零，最直观的解确实是：

$$
H=\frac{Y}{X}
$$

所以，线性滤波器训练的出发点仍然是求解频域乘积 $X\odot H=Y$。问题在于，实际特征频谱中可能存在等于零或非常接近零的 $X[k]$：直接相除会无法计算，或者得到幅值极大的 $H[k]$，进而把图像噪声和特征扰动一起放大。

为得到稳定的滤波器，KCF允许预测响应与 $y$ 存在少量误差，同时限制滤波器系数不能无限增大。这个要求写成带正则化的最小二乘问题：

$$
\min_w
\left\|C(x)w-y\right\|^2
+\lambda\|w\|^2
$$

其中，第一项衡量所有循环位移的预测响应与期望响应之间的误差，第二项用 $\lambda$ 限制滤波器幅值。最小二乘负责寻找误差最小的 $H$，正则化负责避免除零和小数作分母造成的不稳定；频域乘积关系依然保留。

在频域中，每个频率位置可以独立求解。采用“检测时直接与当前频谱相乘”的频域滤波器记法：

$$
H=
\frac{\overline X\odot Y}
{\overline X\odot X+\lambda}
$$

当 $\lambda=0$ 且 $X[k]\neq 0$ 时，有：

$$
\frac{\overline{X[k]}Y[k]}{\overline{X[k]}X[k]}
=\frac{Y[k]}{X[k]}
$$

因此，上式可以理解为 $H=Y/X$ 的稳定版本。

其中：

- $X=\mathcal F(x)$ 是训练特征频谱。
- $Y=\mathcal F(y)$ 是期望响应频谱。
- $H$ 是实际保存的频域线性滤波器系数。

训练流程为：

```text
第一帧搜索区域
→ 提取固定尺寸特征x
→ DFT得到X
→ 生成高斯期望响应y
→ DFT得到Y
→ 逐频率计算H
→ 保存H
```

当前Demo没有单独实现完整线性KCF训练器。Demo01和Demo02已经提供DFT、共轭乘法和复数除法，第6章保留线性公式作为高斯核KCF的基础，不引用Demo10冒充线性模型。

### 6.2 线性相关滤波器的推理流程

下一帧以旧目标中心建立同样模型几何的搜索区域，提取当前特征 $z$，然后计算：

$$
Z=\mathcal F(z)
$$

$$
R=Z\odot H
$$

$$
r=\mathcal F^{-1}(R)
$$

$r$ 是最终响应图。若使用空间滤波器频谱 $W=\mathcal F(w)$ 的记法，相关公式写成：

$$
R=Z\odot\overline W
$$

这两种写法只是在变量 $H$ 中是否已经包含共轭方向。工程代码需要统一一套定义，并用已知平移样本验证峰值方向。

### 6.3 线性相关滤波器的局限

线性滤波器对特征做加权求和：

$$
s=w^Tx
$$

它能学习哪些特征应当提高或降低分数，但打分关系仍是线性的。真实目标的形变、背景结构和多通道HOG之间可能形成更复杂的关系。高斯核KCF通过特征距离和指数映射，在不显式构造高维特征的情况下获得非线性相似度。

高斯核也会增加参数敏感性。核宽度过小会让轻微外观变化导致相似度快速下降，过大则会让不同特征都得到相近分数。

## 7 高斯核对线性KCF的核化扩展

### 7.1 高斯核函数的原理介绍

线性相关使用点积衡量两个特征的匹配程度。点积会把对应位置的特征值相乘后相加，因此特征方向越接近、幅值越大，结果越高。KCF希望增加一种更灵活的关系：两个特征越接近，相似度越高；差异逐渐增大时，相似度可以快速下降。高斯核函数用下面的形式完成这次转换：

$$
k(x,z)=
\exp\left(
-\frac{\|x-z\|^2}{\sigma_k^2}
\right)
$$

这个公式可以按照计算顺序拆开理解：

1. $\|x-z\|^2$ 计算两个特征的平方距离。特征完全相同时距离为0，差异越大，距离越大。
2. 除以 $\sigma_k^2$ 调整算法对差异的容忍程度。$\sigma_k$ 越大，同样的特征差异产生的相似度下降越慢；$\sigma_k$ 越小，相似度下降越快。
3. 前面的负号让距离增大时指数变小。
4. 指数函数 $\exp(\cdot)$ 把范围为 $[0,+\infty)$ 的距离转换到 $(0,1]$ 的相似度范围内。

因此，这种形式同时满足三个需要：完全相同的特征得到最高值1；特征差异增大时相似度连续下降；输出始终为正，便于把它作为后续评分的基础。它没有写概率密度中的归一化系数，因为这里关心的是特征相似度，并要求 $k(x,x)=1$。

例如，当 $\|x-z\|=\sigma_k$ 时：

$$
k(x,z)=e^{-1}\approx0.368
$$

当距离增加到 $2\sigma_k$ 时：

$$
k(x,z)=e^{-4}\approx0.018
$$

这说明 $\sigma_k$ 直接决定了相似度随特征距离下降的速度。

从核方法的角度看，高斯核还可以写成：

$$
k(x,z)=\phi(x)^T\phi(z)
$$

$\phi(\cdot)$ 表示把原始特征映射到另一个特征空间。对于高斯核，这个特征空间在精确的数学表达中是无限维的。原因可以从指数函数的无穷级数看出：

$$
\exp\left(\frac{2x^Tz}{\sigma_k^2}\right)
=
\sum_{n=0}^{\infty}
\frac{1}{n!}
\left(\frac{2x^Tz}{\sigma_k^2}\right)^n
$$

这个展开式同时包含零次、一次、二次以及更高次数的特征组合，所以可以把高斯核理解为在无限维特征空间中计算相关性。计算机无法显式创建并保存完整的无限维特征 $\phi(x)$ 和 $\phi(z)$，KCF也不会进行这一步。核技巧直接使用高斯核公式计算内积 $\phi(x)^T\phi(z)$，用有限次的距离、除法和指数运算得到无限维空间中的相似度结果。

这里需要区分“隐式特征维数”和“程序中的结果尺寸”。假设输入FHOG特征图的尺寸为：

$$
H\times W\times C
$$

高斯核会把各通道在同一个循环位移下的距离汇总成一个相似度数值。全部 $H\times W$ 个循环位移最终得到一张：

$$
H\times W
$$

的高斯核相似度图，模型系数 $\alpha$ 也排列为 $H\times W$。因此，它们与原特征图拥有相同的空间位置数量；当原特征图包含 $C$ 个通道时，高斯核结果不再保留这 $C$ 个通道。例如，$16\times16\times31$ 的FHOG特征经过高斯核计算后得到 $16\times16$ 的核相似度图，$\alpha$ 同样是 $16\times16$。

上面的 $k(x,z)$ 只比较一对特征，因此结果是一个相似度数值。KCF会让模板特征 $x$ 分别与当前搜索特征 $z$ 的所有循环位移比较，于是得到一张与特征图同宽高的高斯核相似度图：

$$
k^{xz}[i]=k(x,P_i z)
$$

其中，$P_i z$ 表示当前特征的第 $i$ 个循环位移，$k^{xz}[i]$ 表示该位移与模板的相似度。图中每个坐标代表一个候选位移，数值越大，说明该位移下的当前特征越接近模板特征。

高斯核相似度图仍是一张中间结果。它只说明每个位移与模板有多相似，还没有学习“这个相似度应该对应多少目标得分”。例如，目标只移动一格时仍有大量特征重合，原始核相似度可能依然很高，整张图会形成较宽的高分区域；而训练时预设的高斯响应要求中心得分最高，周围得分按指定速度下降。

因此，高斯核KCF还需要学习一组模型系数 $\alpha$，用它把原始核相似度转换成期望的目标响应。设所有循环位移训练样本组成核矩阵 $K$，训练的基本目标可以写成：

$$
K\alpha\approx y
$$

其中，$y$ 是预设的高斯响应，$\alpha$ 中的每个系数表示相应循环位移训练样本的核相似度对最终得分产生多大影响。它通常是一组与循环位移数量相同的系数，并非单独一个数。

推理时，模板特征与当前特征先产生高斯核相似度图 $k^{xz}$，再由训练好的 $\alpha$ 对它进行加权，得到最终响应图 $r$：

$$
r=
\mathcal F^{-1}
\left(
\widehat{\alpha}\odot\widehat{k^{xz}}
\right)
$$

所以，高斯核负责计算“各个位移有多相似”，$\alpha$ 负责把这些相似度转换成“各个位移应该得到多少目标分数”。模板特征 $x$ 与模型系数 $\alpha$ 共同组成高斯核KCF的跟踪模型。7.2和7.3将继续说明所有位移的距离与高斯核相似度图如何一次计算出来，7.4和7.5再给出 $\alpha$ 的训练与使用公式。

### 7.2 模板特征与当前特征的循环相关计算

高斯核需要计算每个位移下的特征距离。设保存的模板特征为 $x$，当前搜索特征为 $z$，第 $i$ 个循环位移为 $P_i z$。距离展开为：

$$
\|x-P_i z\|^2
=
\|x\|^2+\|z\|^2-2x^TP_i z
$$

其中 $x^TP_i z$ 正是第 $i$ 个循环位移的相关值。全部位移的相关值可以一次计算：

$$
c=
\mathcal F^{-1}
\left(
\sum_{q=1}^{C}Z_q\odot\overline{X_q}
\right)
$$

$q$ 表示特征通道。每个通道分别相关，再将频谱相加，IDFT后得到所有位移的多通道点积。

以下代码来自Demo09的 `09_gaussian_correlation_demo.cpp` 第61—119行。

```cpp
// 两个输入均为H×W×C特征；每个通道保存一种FHOG方向或纹理信息。
std::vector<cv::Mat> referenceChannels;
std::vector<cv::Mat> sampleChannels;

cv::split(referenceFeature, referenceChannels); // 模板特征x的C个通道。
cv::split(sampleFeature, sampleChannels);

// 所有通道的互功率频谱最终累加到同一张H×W复数频谱。
cv::Mat summedCrossSpectrum = cv::Mat::zeros(
    referenceFeature.size(),
    CV_32FC2);

for (int channel = 0;
     channel < referenceFeature.channels();
     ++channel)
{
    // 对模板当前通道执行DFT，得到X_q。
    const cv::Mat referenceSpectrum =
        dft_demo::forwardDft(referenceChannels[channel]);

    // 对候选特征当前通道执行DFT，得到Z_q。
    const cv::Mat sampleSpectrum =
        dft_demo::forwardDft(sampleChannels[channel]);

    // true使第二个输入取共轭，计算Z_q·conj(X_q)，对应循环相关。
    const cv::Mat channelCrossSpectrum =
        complex_spectrum_demo::multiplySpectrums(
            sampleSpectrum,
            referenceSpectrum,
            true);

    // 对C个特征通道求和，等价于每个位移下的多通道特征点积。
    summedCrossSpectrum += channelCrossSpectrum;
}

// IDFT后得到H×W实数相关图；每个位置对应一个循环位移的点积。
result.crossCorrelation =
    dft_demo::inverseDft(summedCrossSpectrum);
```

这里 `true` 表示第二个频谱 `referenceSpectrum` 取共轭，计算 $Z_q\overline{X_q}$。交换共轭对象会反转位移方向。

### 7.3 从循环相关值到高斯核相似度图

得到全部位移相关值 $c[i]$ 后，可以同时计算全部平方距离：

$$
d[i]=
\frac{
\|x\|^2+\|z\|^2-2c[i]
}{N}
$$

$N=H\times W\times C$ 是特征值总数。除以 $N$ 可以降低特征尺寸和通道数对核距离尺度的影响。

再逐位置计算：

$$
k^{xz}[i]=
\exp\left(-\frac{d[i]}{\sigma_k^2}\right)
$$

$k^{xz}$ 是高斯核相似度图：坐标仍表示循环位移，数值表示模板特征与当前特征在该位移下的核相似度。模型系数 $\alpha$ 还需要继续处理这张图，处理结果才是KCF最终响应图。

以下代码来自Demo09的 `09_gaussian_correlation_demo.cpp` 第127—186行。

```cpp
// ||x||^2和||z||^2分别是模板与当前多通道特征所有元素的平方和。
const double referenceNormSquared =
    cv::norm(referenceFeature, cv::NORM_L2SQR);

const double sampleNormSquared =
    cv::norm(sampleFeature, cv::NORM_L2SQR);

// N=H×W×C用于把总平方距离归一化成平均特征距离。
const int numberOfValues =
    referenceFeature.rows *
    referenceFeature.cols *
    referenceFeature.channels();

// 对每个位移使用||x-z_i||^2=||x||^2+||z||^2-2<x,z_i>。
// crossCorrelation是H×W，因此一次得到全部循环位移的距离图。
result.squaredDistance =
    static_cast<float>(referenceNormSquared + sampleNormSquared) -
    2.0F * result.crossCorrelation;

// 除以特征总数，降低特征尺寸和通道数量对sigma含义的影响。
result.squaredDistance /=
    static_cast<float>(numberOfValues);

// 理论平方距离不小于0；浮点DFT误差可能产生极小负数，需要截断为0。
cv::max(
    result.squaredDistance,
    0.0,
    result.squaredDistance);

// 将距离代入exp(-d/sigma^2)，得到0~1范围的高斯核相似度。
const float sigmaSquared = sigma * sigma;
const cv::Mat exponent =
    -result.squaredDistance / sigmaSquared;

cv::exp(exponent, result.kernel); // 输出H×W核相似度图，每个元素对应一个位移。
// 训练和推理都在频域组合核图与Alpha，因此同时保存核图频谱。
result.kernelSpectrum =
    dft_demo::forwardDft(result.kernel);
```

`cv::max(..., 0.0, ...)` 用于消除DFT和浮点运算产生的微小负距离。

### 7.4 高斯核相似度图、模型系数与最终响应图

高斯核相似度图只描述模板和当前特征在各个位移下有多相似。KCF还需要让这些相似度经过训练后接近期望响应，因此引入模型系数 $\alpha$。

训练方程为：

$$
(K+\lambda I)\alpha=y
$$

$K$ 是所有循环训练样本之间的核矩阵。循环结构让它在频域中可以逐点求解。推理时，当前核相似度图与 $\alpha$ 组合：

$$
R=\widehat{\alpha}\odot K^{xz}
$$

$$
r=\mathcal F^{-1}(R)
$$

因此，高斯核KCF模型由两部分组成：

```text
模板特征x：用于与当前特征计算高斯核相似度
模型系数Alpha：用于把核相似度图转换成最终响应图
```

### 7.5 高斯核KCF的训练流程

训练时当前特征和模板特征都是第一帧特征 $x$。先计算模板与自身所有循环位移的高斯核相关 $k^{xx}$：

$$
k^{xx}[i]=
\exp\left(
-\frac{\|x-P_i x\|^2}{\sigma_k^2}
\right)
$$

然后进行DFT：

$$
K^{xx}=\mathcal F(k^{xx}),\qquad
Y=\mathcal F(y)
$$

模型系数为：

$$
\widehat{\alpha}=
\frac{Y}{K^{xx}+\lambda}
$$

完整流程为：

```text
第一帧搜索区域
→ 提取模板特征x
→ x与x进行多通道循环相关
→ 根据相关值计算全部位移的平方距离
→ 代入高斯核，得到kxx
→ DFT得到Kxx
→ 生成高斯期望响应y并得到Y
→ Alpha = Y / (Kxx + lambda)
→ 保存模板特征x和模型系数Alpha
```

这里存在两个不同的“高斯”：高斯期望响应 $y$ 规定各个位移应该得到多少分；高斯核 $k^{xx}$ 规定两个特征在某个位移下有多相似。

以下代码来自Demo10的 `10_filter_train_demo.cpp` 第98—169行。

```cpp
// 保存训练配置和模板特征；clone使模型独立拥有数据，不依赖调用者矩阵寿命。
model.templateFeature = templateFeature.clone();
model.labelSigma = labelSigma;
model.kernelSigma = kernelSigma;
model.regularization = regularization;

// 创建H×W高斯期望响应y：中心位移得分最高，远离中心逐渐降低。
model.desiredResponse =
    gaussian_label_demo::createGaussianLabel(
        templateFeature.size(),
        labelSigma);

// Y=DFT(y)，作为Alpha训练公式的分子。
model.desiredResponseSpectrum =
    dft_demo::forwardDft(model.desiredResponse);

// 模板与自身所有循环位移比较，得到kxx及其频谱Kxx。
const gaussian_correlation_demo::GaussianCorrelationResult
    selfCorrelation =
    gaussian_correlation_demo::computeGaussianCorrelation(
        model.templateFeature,
        model.templateFeature,
        kernelSigma);

model.selfKernel = selfCorrelation.kernel; // H×W时域高斯核相似度图。
model.selfKernelSpectrum = selfCorrelation.kernelSpectrum;

// 在Kxx的每个频率点加入lambda，避免分母过小导致Alpha过大。
model.regularizedKernelSpectrum =
    addRegularizationToSpectrum(
        model.selfKernelSpectrum,
        regularization);

// 按Alpha=Y/(Kxx+lambda)逐频率执行复数除法。
// alphaSpectrum与核相似度图同为H×W复数频谱，是模型的可训练系数。
model.alphaSpectrum =
    complex_spectrum_demo::divideSpectrums(
        model.desiredResponseSpectrum,
        model.regularizedKernelSpectrum,
        1e-12F);
```

### 7.6 高斯核KCF的推理流程

下一帧得到当前搜索特征 $z$ 后，使用已保存的模板特征 $x$ 计算 $k^{xz}$，再与模型系数相乘：

$$
c=
\mathcal F^{-1}
\left(
\sum_q Z_q\overline{X_q}
\right)
$$

$$
k^{xz}[i]=
\exp\left(
-\frac{
\|x\|^2+\|z\|^2-2c[i]
}{N\sigma_k^2}
\right)
$$

$$
r=
\mathcal F^{-1}
\left(
\widehat{\alpha}\odot\mathcal F(k^{xz})
\right)
$$

推理流程为：

```text
下一帧旧目标附近的搜索区域
→ 提取当前特征z
→ z与保存的模板特征x做频域循环相关
→ IDFT得到各个位移的线性相关值
→ 计算平方距离并代入高斯核
→ 得到核相似度图kxz
→ DFT得到Kxz
→ 与模型系数Alpha逐点相乘
→ IDFT得到最终响应图r
→ 查找峰值并换算目标位移
```

以下代码来自Demo11的 `11_response_detection_demo.cpp` 第454—511行。

```cpp
/**
 * @brief 使用已训练的高斯核KCF模型在当前搜索特征中定位目标。
 * @param model 保存模板特征x、核宽度和Alpha频谱的跟踪模型。
 * @param currentFeature 当前帧搜索区域提取的H×W×C特征，尺寸和类型必须与模板一致。
 * @param psrExclusionRadius 计算PSR时从主峰周围排除的cell半径。
 * @return 核相似度图、最终响应图以及峰值位置、亚像素偏移和PSR。
 */
DetectionResult detectTarget(
    const filter_train_demo::CorrelationFilterModel& model,
    const cv::Mat& currentFeature,
    int psrExclusionRadius)
{
    // 模型缺少模板或Alpha时无法计算响应，直接报告调用错误。
    if (model.templateFeature.empty() ||
        model.alphaSpectrum.empty())
    {
        throw std::invalid_argument(
            "detectTarget: correlation filter model is empty.");
    }

    // KCF逐频率运算要求当前特征与训练模板拥有完全相同的布局。
    if (currentFeature.size() != model.templateFeature.size() ||
        currentFeature.type() != model.templateFeature.type())
    {
        throw std::invalid_argument(
            "detectTarget: currentFeature must match templateFeature.");
    }

    DetectionResult result; // 保存中间核图和最终检测结果，便于调试显示。

    // 计算模板x与当前特征z在所有循环位移下的高斯核相似度kxz。
    const gaussian_correlation_demo::GaussianCorrelationResult correlation =
        gaussian_correlation_demo::computeGaussianCorrelation(
            model.templateFeature,
            currentFeature,
            model.kernelSigma);

    result.kernel = correlation.kernel; // H×W时域核相似度图。
    result.kernelSpectrum = correlation.kernelSpectrum;

    // R=Alpha·Kxz；false表示普通复数乘法，不额外取共轭。
    result.responseSpectrum =
        complex_spectrum_demo::multiplySpectrums(
            model.alphaSpectrum,
            result.kernelSpectrum,
            false);

    // IDFT得到H×W最终响应图，每个位置表示对应位移的目标得分。
    result.response =
        dft_demo::inverseDft(result.responseSpectrum);

    // 查找主峰、亚像素偏移和PSR；主峰坐标随后会转换成原图位移。
    result.peak =
        locateResponsePeak(result.response, psrExclusionRadius);

    return result;
}
```

最终响应图中的峰值坐标位于循环坐标系。Demo11将峰值相对响应中心的偏移转换成Cell位移，再乘Cell尺寸和搜索区域缩放比例，得到原图像素位移。

以下代码来自Demo11的 `11_response_detection_demo.cpp` 第429—443行和第515—543行。

```cpp
// peakX/peakY是响应图主峰整数坐标；response中心代表零位移。
// subPixelOffset通过邻近响应值拟合得到，用于补偿cell级整数定位误差。
float displacementX =
    static_cast<float>(peakX - response.cols / 2) +
    result.subPixelOffset.x;

float displacementY =
    static_cast<float>(peakY - response.rows / 2) +
    result.subPixelOffset.y;

// 响应来自循环相关，超过半幅的位移应解释为反方向的短位移。
displacementX = wrapDisplacement(displacementX, response.cols);
displacementY = wrapDisplacement(displacementY, response.rows);

// featureDisplacement单位为特征cell；转换后才能得到模型图像像素和原图像素。
result.featureDisplacement =
    cv::Point2f(displacementX, displacementY);

/**
 * @brief 将特征cell位移换算成固定模型图像中的像素位移。
 * @param featureDisplacement x/y单位均为cell。
 * @param cellSize 一个cell覆盖的模型像素宽高。
 * @return 固定模型图像坐标系中的像素位移。
 */
cv::Point2f featureDisplacementToPatch(
    const cv::Point2f& featureDisplacement,
    const cv::Size& cellSize)
{
    return cv::Point2f(
        featureDisplacement.x * static_cast<float>(cellSize.width),
        featureDisplacement.y * static_cast<float>(cellSize.height));
}

/**
 * @brief 将特征cell位移继续换算成原图像素位移。
 * @param featureDisplacement 响应图给出的cell位移。
 * @param cellSize cell到固定模型图像的缩放比例。
 * @param searchPatch 保存固定模型图像到原搜索区域的x/y缩放比例。
 * @return 原图坐标系中的像素位移，可直接用于更新目标框中心。
 */
cv::Point2f featureDisplacementToImage(
    const cv::Point2f& featureDisplacement,
    const cv::Size& cellSize,
    const image_patch_demo::SearchPatchResult& searchPatch)
{
    // 第一步：cell位移乘cell尺寸，得到固定模型图像中的位移。
    const cv::Point2f patchDisplacement =
        featureDisplacementToPatch(featureDisplacement, cellSize);

    // 第二步：乘搜索区域缩放比例，恢复成原图像素位移。
    return image_patch_demo::patchDisplacementToImage(
        searchPatch,
        patchDisplacement);
}
```

## 8 模板特征与模型系数的在线更新

### 8.1 使用学习率更新模板特征和模型系数

第一帧模板无法覆盖目标后续所有外观。目标转向、姿态变化和光照变化时，模型需要吸收当前可靠特征。设学习率为 $\eta$：

$$
x_t=(1-\eta)x_{t-1}+\eta x_{current}
$$

$$
\widehat{\alpha}_t=
(1-\eta)\widehat{\alpha}_{t-1}
+\eta\widehat{\alpha}_{current}
$$

模板特征和模型系数必须使用相同学习率更新，使两部分保持同一时间状态。$\eta=0$ 时模型不变，$\eta=1$ 时完全采用当前帧模型。

以下代码来自Demo14的 `14_online_update_demo.cpp` 第493—585行。

```cpp
/**
 * @brief 使用指数移动平均同时更新历史模板特征和Alpha频谱。
 * @param historicalModel 输入输出参数；调用前为旧模型，调用后保存融合模型。
 * @param currentModel 在当前可靠目标位置重新训练得到的临时模型。
 * @param learningRate 学习率eta，取值范围[0,1]。
 */
void interpolateTrackingModel(
    filter_train_demo::CorrelationFilterModel& historicalModel,
    const filter_train_demo::CorrelationFilterModel& currentModel,
    float learningRate)
{
    // 拒绝NaN、无穷和范围外学习率，防止整张模型被非法数值污染。
    if (!std::isfinite(learningRate) ||
        learningRate < 0.0F ||
        learningRate > 1.0F)
    {
        throw std::invalid_argument(
            "interpolateTrackingModel: learningRate must be in [0, 1].");
    }

    // eta=0表示完全保留历史模型，不进行任何内存修改。
    if (learningRate == 0.0F)
    {
        return;
    }

    // eta=1表示完全采用当前模型；clone保证historicalModel独立拥有矩阵数据。
    if (learningRate == 1.0F)
    {
        historicalModel.templateFeature =
            currentModel.templateFeature.clone();
        historicalModel.alphaSpectrum =
            currentModel.alphaSpectrum.clone();
        return;
    }

    // 一般情况：旧模型权重为1-eta，当前模型权重为eta。
    const double historicalWeight =
        1.0 - static_cast<double>(learningRate);
    const double currentWeight =
        static_cast<double>(learningRate);

    // 临时结果避免在模板更新后又使用已经修改的数据计算Alpha。
    cv::Mat blendedTemplate;
    cv::Mat blendedAlpha;

    // 对H×W×C模板特征逐元素做指数移动平均。
    cv::addWeighted(
        historicalModel.templateFeature,
        historicalWeight,
        currentModel.templateFeature,
        currentWeight,
        0.0,
        blendedTemplate);

    // 对H×W复数Alpha频谱逐元素使用相同学习率融合。
    cv::addWeighted(
        historicalModel.alphaSpectrum,
        historicalWeight,
        currentModel.alphaSpectrum,
        currentWeight,
        0.0,
        blendedAlpha);

    // 两项均计算成功后再提交新状态，使模板与Alpha保持同一时间版本。
    historicalModel.templateFeature = std::move(blendedTemplate);
    historicalModel.alphaSpectrum = std::move(blendedAlpha);
}
```

### 8.2 更新间隔、更新速度与模板适应能力

学习率决定每次更新吸收多少当前外观，更新间隔决定多长时间执行一次更新。两者共同决定实际适应速度。

每帧以较大学习率更新，模型能够快速跟随姿态变化，也会快速吸收短暂遮挡和背景。减小学习率或每隔 $N$ 帧更新一次，可以降低短期干扰进入模型的速度，同时会降低对真实外观变化的跟随速度。

实际跟踪器通常先判断当前定位结果是否可靠，再决定是否更新。一次较高的响应可能来自树枝、车灯或相似背景，因此仅凭单帧峰值超过阈值就立即训练仍有较大风险。更稳妥的更新条件可以写成：

1. 跟踪状态为可靠状态，没有处于弱响应、丢失或遮挡状态。
2. 响应峰值不低于更新峰值阈值 $T_{peak}$。
3. 峰值旁瓣比（Peak-to-Sidelobe Ratio，PSR）不低于更新阈值 $T_{psr}$。PSR表示主峰相对周围旁瓣的突出程度，数值较高说明响应图更接近清晰的单峰。
4. 上述可靠条件连续保持 $M$ 帧。单帧偶然产生的高峰不会立即写入模板。
5. 当前帧距离上次更新至少经过 $N$ 帧。这个更新间隔用于限制重训练频率。
6. 本帧位移和尺度变化没有超过允许范围，防止突然跳到背景后仍触发更新。

这些条件需要同时满足：

$$
updateAllowed=
reliable
\land peak\ge T_{peak}
\land PSR\ge T_{psr}
\land stableCount\ge M
\land (frameIndex-lastUpdateFrame)\ge N
\land geometryValid
$$

Demo14源码中的真实默认参数位于 `14_online_update_demo.h`：`updatePeakThreshold=0.35F`、`enableLowConfidenceProtection=true`、`learningRate=0.02F`。因此，Demo14当前把“允许更新”定义为响应峰值 `peakValue >= 0.35`，通过后当前帧模型以2%的学习率融合进历史模型。Demo14没有设置PSR健康阈值，也没有实现连续可靠帧数和更新间隔。

若在Demo14基础上增加前面的完整门控，可以先用下面的扩展示例观察行为：采用比源码更严格的峰值阈值 $T_{peak}=0.55$、PSR阈值 $T_{psr}=8.0$、连续可靠帧数 $M=3$、更新间隔 $N=5$ 帧。这里的0.55、8.0、3帧和5帧均为建议实验值；Demo14现有代码只包含0.35的Peak阈值。假设第20帧开始满足置信度条件，第20、21、22帧连续可靠，并且距离上次更新已经超过5帧，那么第22帧才允许重训练。若第21帧置信度下降，则连续可靠计数清零，需要重新累计3帧。

响应峰值的范围会受到特征归一化、核宽度和响应计算方式影响，实际工程应在目标清晰、轻度遮挡和完全丢失三类视频片段上记录统计值，再确定 $T_{peak}$ 与 $T_{psr}$。

更新条件成立后，跟踪器使用本帧已经更新完成的目标位置重新截取搜索区域、提取特征并训练当前帧模型。随后按照8.1节的学习率，将当前模板特征和当前模型系数逐步融合进历史模型。这里的“重训练”表示生成一份当前帧模型再进行插值；直接用当前模型完全覆盖历史模型相当于 $\eta=1$，对短暂遮挡非常敏感。

完整判断顺序为：

```text
当前帧得到响应图和目标位置
→ 检查跟踪状态、Peak和PSR
→ 累计或清零连续可靠帧数stableCount
→ 检查距离上次更新的帧数
→ 检查位移与尺度是否发生异常突变
→ 条件全部满足后，在新目标位置重新提取训练特征
→ 训练当前帧的模板特征和模型系数
→ 按学习率融合到历史模型
→ 记录lastUpdateFrame并清零stableCount
```

Demo14先使用旧目标中心提取检测特征并计算新目标位置。检测特征中的目标可能已经偏离中心，因此代码不会直接拿检测特征训练；它会以更新后的 `targetRect_` 为中心重新提取 `trainingFeature`，再训练当前帧模型。

以下代码来自Demo14的 `14_online_update_demo.cpp` 第866—915行。

```cpp
// Demo14默认配置位于14_online_update_demo.h：
// updatePeakThreshold=0.35F，enableLowConfidenceProtection=true，learningRate=0.02F。
// 当前Demo只用Peak作更新门控，还没有加入PSR、连续可靠帧数和更新间隔。
result.updateAllowed =
    !config_.enableLowConfidenceProtection ||
    result.peakValue >= config_.updatePeakThreshold;

// 只有置信度门控通过且学习率大于0时，历史模型才允许改变。
if (result.updateAllowed &&
    config_.learningRate > 0.0F)
{
    // targetRect_已经根据当前响应峰值更新。
    // 必须以新目标中心重新截取搜索区域，避免把偏移目标当成训练中心。
    const cc_fhog_demo::CcFhogResult trainingFeature =
        featureExtractor_.extractFromFrame(
            frame,
            targetRect_);

    // 使用当前可靠特征重新训练一份临时模板和Alpha，历史模型此时仍未改变。
    const filter_train_demo::CorrelationFilterModel currentModel =
        filter_train_demo::trainCorrelationFilter(
            trainingFeature.feature,
            config_.trackerConfig.labelSigma,
            config_.trackerConfig.kernelSigma,
            config_.trackerConfig.regularization);

    // 按learningRate同时融合模板和Alpha；默认0.02表示当前模型占2%。
    interpolateTrackingModel(
        model_,
        currentModel,
        config_.learningRate);

    result.modelUpdated = true; // 告知调用者本帧确实执行了模型更新。
}
```

如果需要固定更新间隔，可以保存 `lastUpdateFrame`，仅在 `frameIndex - lastUpdateFrame >= updateInterval` 时允许训练当前模型。现有Demo14还没有加入连续可靠帧数和更新间隔判断，因此正文不提供伪装成Demo源码的实现片段。

### 8.3 错误更新导致模板污染的问题

在线更新建立在“当前定位结果可靠”的前提上。目标被树枝遮挡时，如果响应仍勉强超过更新阈值，重新提取的训练区域就会包含大量树枝。连续更新后，模板会逐渐从目标外观转成遮挡物或背景，这就是模板污染。

因此，在线更新至少需要以下约束：

- 当前Peak和PSR达到更新阈值。
- 可靠状态连续保持规定帧数，并且到达更新间隔。
- 当前位移和尺度变化处于允许范围。
- 使用更新后的目标中心重新提取训练区域。
- 模板特征和模型系数同时更新。

更完整的实现还会加入峰值形状、PSR、连续弱响应计数、健康模板和遮挡冻结策略。这些决策属于后续鲁棒跟踪文章，本篇停留在“模型为何更新、怎样插值、错误更新为何造成漂移”的基础闭环。

### 8.4 响应峰值的亚像素位置补偿

响应图只在整数网格位置保存响应值，真正的连续峰值可能落在两个网格点之间。亚像素峰值估计不会恢复特征图已经丢失的图像细节，它根据整数峰值附近的响应曲线，继续估计峰顶的小数位置。

假设整数峰值位于位置 $0$，它左侧、中心和右侧的响应分别为：

$$
f(-1)=r_{-1},\qquad f(0)=r_0,\qquad f(1)=r_{+1}
$$

相关滤波使用平滑的高斯期望响应，因此主峰附近通常可以用二次函数近似：

$$
f(x)=ax^2+bx+c
$$

将三个响应值代入，可以得到：

$$
c=r_0
$$

$$
b=\frac{r_{+1}-r_{-1}}{2}
$$

$$
a=\frac{r_{-1}-2r_0+r_{+1}}{2}
$$

抛物线顶点位于 $\delta=-b/(2a)$，整理后得到小数偏移：

$$
\delta=\frac{1}{2}\cdot
\frac{r_{-1}-r_{+1}}{r_{-1}-2r_0+r_{+1}}
$$

例如三个响应值为：

$$
r_{-1}=0.8,\qquad r_0=1.0,\qquad r_{+1}=0.9
$$

整数最大值位于位置 $0$，右侧响应高于左侧，说明真实峰顶可能稍微偏右。代入公式：

$$
\delta=\frac{1}{2}\cdot
\frac{0.8-0.9}{0.8-2\times1.0+0.9}
\approx0.167
$$

因此峰值位置估计为 $0.167$ 个响应网格。若响应图与FHOG Cell网格对应，这里的单位就是Cell；换回原图位移时，还需要乘以Cell尺寸和搜索区域缩放比例。

这和直接对响应图做线性插值存在关键区别。线性插值在相邻两个采样点之间生成加权平均值：

$$
r(t)=(1-t)r_0+tr_1,\qquad 0\le t\le1
$$

一条线段上的最大值仍位于两个端点中较大的那个位置。把响应图用线性或双线性插值放大，只会补充端点之间的响应数值，通常不会把最大值移动到一个新的小数峰顶。抛物线估计同时观察左、中、右三个点，能够利用曲线弯曲程度求出顶点位置。

两种方法的作用可以概括为：

| 方法 | 主要作用 | 对峰值位置的结果 |
|---|---|---|
| 线性或双线性插值 | 补充相邻采样点之间的数值 | 最大值通常仍落在原整数峰值处 |
| 三点抛物线估计 | 拟合峰值附近的弯曲形状 | 可以得到峰顶的小数位置 |

实现时需要防止分母 $r_{-1}-2r_0+r_{+1}$ 接近零，并把 $\delta$ 限制在 $[-0.5,0.5]$ 附近。水平方向和垂直方向分别计算一次，即可得到二维小数偏移。遮挡或背景干扰产生多个相近峰值时，抛物线估计无法修复目标身份错误，此时仍需结合Peak、PSR和跟踪状态判断结果是否可靠。
