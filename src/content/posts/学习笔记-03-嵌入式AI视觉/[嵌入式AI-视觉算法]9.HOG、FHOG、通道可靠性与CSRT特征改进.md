---
title: '[嵌入式AI-视觉算法] HOG、FHOG、通道可靠性与CSRT特征改进'
published: 2026-09-24T08:39:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍HOG、FHOG、通道可靠性与CSRT特征改进的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '计算机视觉', '深度学习']
category: '嵌入式AI-视觉算法'
draft: false
passwordProtected: true
lang: zh_CN
---

# 阶段3-9 HOG、FHOG、通道可靠性与CSRT特征改进

阶段3-8已经完成了相关滤波的数学闭环：从搜索区域提取特征，用训练好的模型计算响应图，再根据峰值求出目标位移。本章只解决其中一个问题：**搜索区域应当用什么特征表示，才能让相关滤波器更稳定地辨认目标？**

灰度值能够直接使用，但目标一旦遇到光照变化、局部遮挡或背景中存在相近亮度区域，灰度模板就容易发生混淆。HOG（Histogram of Oriented Gradients，方向梯度直方图）把图像转换为局部轮廓方向；FHOG（Felzenszwalb HOG）进一步组织方向通道和归一化结果，使其可以作为相关滤波器的多通道特征图。CSRT（Discriminative Correlation Filter with Channel and Spatial Reliability，具有通道与空间可靠性的判别式相关滤波）则继续判断哪些特征通道、哪些空间位置更可信。

本文中的实现分别来自 Track Demo 的 Demo07、Demo08、Demo12 和 Demo19。它们沿着同一条数据链逐步增加能力：

```text
搜索区域图像
→ 像素梯度
→ Cell方向直方图
→ Block归一化
→ 二维HOG特征图
→ 31通道FHOG特征图
→ 相关滤波或CSRT跟踪器
```

## 1 从灰度特征到梯度特征

### 1.1 灰度特征在相关滤波中的作用与局限

灰度特征保留每个像素的明暗值。假设搜索区域经过统一缩放后为 $64\times64$，那么灰度特征仍然是一张 $64\times64$ 的单通道矩阵。相关滤波器可以直接学习这张矩阵中目标和周围背景的分布。

这种表示方式的优点是计算简单，缺点是它对像素值本身依赖很强。目标处于阴影中、相机自动曝光发生变化或目标表面反光时，同一物体的灰度值会整体改变。背景中只要出现亮度结构接近的区域，也可能形成较高响应。

跟踪时真正需要长期保持的往往是物体轮廓。例如一辆白车从阳光下进入树荫，车身亮度变化很大，但车顶、车窗、车尾等边缘结构仍然存在。因此可以把“这里有多亮”改写为“这里沿哪个方向变化得最明显”。这个变化就是梯度。

### 1.2 HOG和FHOG在相关滤波中的位置

HOG负责把一张图像变成一组局部方向统计。它并不直接输出目标位置，也不负责训练滤波器。它位于搜索区域和相关滤波模型之间：

```text
当前帧
→ 根据上一帧位置截取搜索区域
→ HOG/FHOG提取特征图
→ 与相关滤波模型计算响应图
→ 响应峰值给出目标位移
```

HOG的输入是搜索区域图像，输出是描述局部轮廓的数值。FHOG仍然使用梯度，主要变化在于方向通道的组织方式和归一化结果的保存方式。CC风格实现最终得到 $31$ 个通道，每个通道都可以看成一张较小的二维图；相关滤波器会为这些通道共同学习目标模型。

多通道相关滤波的响应可以写成：

$$
r=\mathcal{F}^{-1}\left(\sum_{c=1}^{C}\overline{\hat{w}_c}\odot\hat{x}_c\right)
$$

其中 $C$ 是特征通道数，$x_c$ 是第 $c$ 个特征通道，$w_c$ 是对应的滤波器通道，$\hat{\cdot}$ 表示离散傅里叶变换，$\overline{\cdot}$ 表示复共轭，$\odot$ 表示逐元素乘法。阶段3-8已经解释了这个相关计算。本章关注 $x_c$ 如何产生。

## 2 从相邻像素得到梯度

### 2.1 为什么使用前后像素做中心差分

一维信号 $I(n)$ 在位置 $n$ 的梯度可以用中心差分近似：

$$
g(n)=I(n+1)-I(n-1)
$$

二维图像需要分别计算水平方向和垂直方向：

$$
g_x(x,y)=I(x+1,y)-I(x-1,y)
$$

$$
g_y(x,y)=I(x,y+1)-I(x,y-1)
$$

也可以使用 $I(n)-I(n-1)$，这种写法叫后向差分。它估计的是区间 $[n-1,n]$ 的变化，估计位置偏向左侧。中心差分同时观察 $n$ 的两侧，估计位置仍位于 $n$，并且一阶导数的离散误差更小。HOG关心边缘方向，中心差分能够让边缘位置和方向更对称。

图像最外侧没有完整的左右或上下邻居。Demo08将外边界梯度置零，避免为教学代码额外引入边界扩展规则。OpenCV的 `Sobel()` 可以完成同类梯度计算，并按照参数指定边界处理方式。

### 2.2 梯度幅值和梯度方向分别表示什么

得到 $g_x$ 和 $g_y$ 后，每个像素的梯度幅值为：

$$
m(x,y)=\sqrt{g_x(x,y)^2+g_y(x,y)^2}
$$

梯度方向为：

$$
\theta(x,y)=\operatorname{atan2}(g_y(x,y),g_x(x,y))
$$

幅值 $m$ 表示这一点变化有多强。均匀区域的相邻像素接近，幅值接近零；物体边界两侧颜色或亮度差异明显，幅值较大。

方向 $\theta$ 表示像素值增长最快的方向。它与人眼看到的边缘方向垂直。例如一条竖直边缘的左右两侧亮度不同，像素值主要沿水平方向变化，因此梯度方向接近 $0^\circ$ 或 $180^\circ$。

以下代码来自 Demo08 的 `CustomHogMapExtractor::extract()` 第399—427行。Demo08直接调用OpenCV `Sobel()` 计算中心差分，`gradientX` 和 `gradientY` 分别保存两个方向的结果。

```cpp
// grayFloat：CV_32FC1灰度图；gradientX：输出水平梯度。
cv::Sobel(
    result.grayFloat,
    result.gradientX,
    CV_32F,              // 输出使用32位浮点数，保留负梯度。
    1,                   // x方向求一阶导数。
    0,                   // y方向不求导。
    1,                   // ksize=1时使用最小中心差分核。
    1.0,
    0.0,
    cv::BORDER_REPLICATE // 边界复制最外侧像素，保证输出尺寸与输入一致。
);

// gradientY：输出垂直梯度，参数中的x、y求导阶数与上面互换。
cv::Sobel(
    result.grayFloat,
    result.gradientY,
    CV_32F,
    0,
    1,
    1,
    1.0,
    0.0,
    cv::BORDER_REPLICATE
);
```

这段代码运行后，`gradientX` 中亮的区域对应明显的左右亮度变化，`gradientY` 中亮的区域对应明显的上下亮度变化。它们还不是HOG特征，只是HOG的像素级输入。

### 2.3 彩色图像为什么选择梯度最强的颜色通道

灰度转换会把B、G、R三个颜色通道合成一个亮度值。两种颜色即使亮度接近，颜色边界仍可能很明显；灰度图可能削弱这条边缘。CC风格FHOG为每个BGR通道分别计算 $g_x$、$g_y$，再选择梯度能量最大的通道：

$$
c^*(x,y)=\arg\max_{c\in\{B,G,R\}}\left(g_{x,c}^2+g_{y,c}^2\right)
$$

最终幅值和方向由 $c^*$ 对应的梯度产生。这里没有把三个颜色梯度相加，因为相加可能让不同方向互相抵消。选择最强通道能够保留该像素最清晰的颜色边缘，同时仍然只向后续步骤提交一组幅值和方向。

## 3 从像素梯度到Cell方向直方图

### 3.1 为什么要把梯度方向划分成多个方向区间

直接保存每个像素的角度会让特征对微小噪声很敏感。例如同一条斜边在两帧中可能分别得到 $39^\circ$ 和 $42^\circ$。轮廓没有发生实质变化，精确角度却不同。

HOG把方向划分为若干区间。经典无符号HOG常将 $0^\circ$ 到 $180^\circ$ 划分为9个方向区间，每个区间宽 $20^\circ$。$39^\circ$ 和 $42^\circ$ 会落入相邻方向，并通过线性插值把权重分配给两个方向桶，使特征变化保持平滑。

选择9个方向是精度和稳定性的折中。方向数量过少时，水平、斜向和垂直轮廓难以细分；方向数量过多时，小幅角度噪声会改变很多通道，同时增加特征通道和相关滤波计算量。CC风格FHOG还使用18个有符号方向，覆盖 $0^\circ$ 到 $360^\circ$，因此能够区分亮到暗与暗到亮的方向。

### 3.2 为什么投票时使用梯度幅值

每个像素会向方向直方图投票，票数由梯度幅值决定。强边缘对局部形状更有代表性，因此贡献更大；平坦区域的梯度接近零，对任何方向几乎都不投票。

假设一个像素的梯度方向位于两个方向中心之间，插值权重分别为 $1-t$ 和 $t$，那么它对两个方向桶的贡献为：

$$
h_{b_0}\mathrel{+}=m(1-t),\qquad h_{b_1}\mathrel{+}=mt
$$

两个贡献之和仍为 $m$。插值只是在相邻方向之间平滑分配信息，不会凭空增加梯度能量。

### 3.3 Cell是什么以及为什么需要Cell

Cell是HOG统计方向的最小空间区域。例如 `cellSize=8` 表示每个Cell覆盖原图中的 $8\times8$ 个像素。这个区域中的所有像素按方向投票，最后得到一个9维直方图：

$$
\mathbf{h}_{cell}=[h_0,h_1,\ldots,h_8]
$$

HOG使用Cell有两个原因。第一，单个像素的方向容易受噪声影响，把邻近像素汇总后能够描述局部轮廓。第二，特征图尺寸会缩小。$64\times64$ 图像使用 $8\times8$ Cell后得到 $8\times8$ 个空间位置，相关滤波只需处理较小的特征图。

以下代码来自 Demo08 的方向和Cell投票部分。它同时对方向和空间位置做线性插值，因此边缘轻微移动时，能量会平滑地流向相邻通道和相邻Cell。

```cpp
// cellHistograms：尺寸为cellRows×cellCols，每个位置包含binCount个方向值。
// 本Demo使用无符号方向，所以angle位于[0, 180)。
const float magnitude = std::sqrt(gx * gx + gy * gy); // 当前像素边缘强度。
float angle = std::atan2(gy, gx) * 180.0F / static_cast<float>(CV_PI);
if (angle < 0.0F) {
    angle += 180.0F; // 180°周期：方向相反的梯度归入同一组轮廓方向。
}

// orientationPosition是浮点方向桶坐标，例如2.25表示位于第2、3桶之间。
const float orientationPosition = angle * static_cast<float>(binCount_) / 180.0F;
const int lowerBin = static_cast<int>(std::floor(orientationPosition)) % binCount_;
const int upperBin = (lowerBin + 1) % binCount_;
const float upperWeight = orientationPosition - std::floor(orientationPosition);
const float lowerWeight = 1.0F - upperWeight;

// 减去0.5使像素中心与Cell中心使用同一个坐标定义。
const float cellX = (static_cast<float>(x) + 0.5F) / cellSize_ - 0.5F;
const float cellY = (static_cast<float>(y) + 0.5F) / cellSize_ - 0.5F;
const int leftCell = static_cast<int>(std::floor(cellX));
const int topCell = static_cast<int>(std::floor(cellY));
const float rightWeight = cellX - std::floor(cellX);
const float bottomWeight = cellY - std::floor(cellY);

// 当前像素最多投给周围4个Cell；越靠近某个Cell中心，该Cell获得的空间权重越大。
for (int offsetY = 0; offsetY <= 1; ++offsetY) {
    const int cellRow = topCell + offsetY;
    if (cellRow < 0 || cellRow >= cellRows) {
        continue; // 超出特征图的空间贡献直接忽略。
    }

    const float spatialYWeight = offsetY == 0 ? 1.0F - bottomWeight : bottomWeight;
    for (int offsetX = 0; offsetX <= 1; ++offsetX) {
        const int cellColumn = leftCell + offsetX;
        if (cellColumn < 0 || cellColumn >= cellColumns) {
            continue;
        }

        const float spatialXWeight = offsetX == 0 ? 1.0F - rightWeight : rightWeight;
        const float weightedMagnitude = magnitude * spatialXWeight * spatialYWeight;
        float* histogram = cellHistograms.ptr<float>(cellRow, cellColumn);

        histogram[lowerBin] += weightedMagnitude * lowerWeight; // 投给较近的方向桶。
        histogram[upperBin] += weightedMagnitude * upperWeight; // 剩余部分投给相邻方向桶。
    }
}
```

## 4 从Cell直方图到Block归一化

### 4.1 为什么不能直接输出Cell直方图

同一个物体在更强光照或更高对比度下，梯度幅值会整体增大。如果直接输出Cell直方图，相关滤波器可能把“边缘整体更强”误认为目标外观发生变化。

Block把相邻多个Cell放在一起归一化。经典设置使用 $2\times2$ 个Cell形成一个Block。设拼接后的向量为 $\mathbf{v}$，第一次L2归一化为：

$$
\mathbf{v}_1=\frac{\mathbf{v}}{\sqrt{\lVert\mathbf{v}\rVert_2^2+\varepsilon^2}}
$$

如果局部区域中所有梯度同时放大 $k$ 倍，分子和分母会同时放大，归一化结果基本不变。HOG因此更关注局部方向比例，减少整体亮度和对比度的影响。

### 4.2 为什么同一个Cell会出现在不同Block中

当Block以一个Cell为步长滑动时，内部Cell最多会出现在左上、右上、左下、右下四个Block中。每个Block的邻域不同，归一化分母也不同，所以同一个Cell会产生多组数值。

这可以保留不同局部上下文。例如同一个竖直边缘Cell放在目标内部时，它周围可能都有稳定边缘；放在目标与背景交界处时，旁边Block可能包含大量平坦背景。两组归一化结果表达了这两种上下文。

OpenCV `HOGDescriptor::compute()`会按Block顺序保留重复的Cell值，所以输出是一维描述子。Demo08为了得到便于相关滤波使用的唯一二维Cell网格，将同一个Cell在多个Block中的归一化结果累加后取平均。Demo12的FHOG保留四个归一化上下文的影响，并把它们压缩组织成31个通道。

### 4.3 为什么L2-Hys需要进行两次归一化

L2-Hys（L2-Hysteresis）包含三个动作：第一次归一化、截断、第二次归一化。

$$
\mathbf{v}_1=\frac{\mathbf{v}}{\sqrt{\lVert\mathbf{v}\rVert_2^2+\varepsilon^2}}
$$

$$
\mathbf{v}_2=\min(\mathbf{v}_1,\tau)
$$

$$
\mathbf{v}_{out}=\frac{\mathbf{v}_2}{\sqrt{\lVert\mathbf{v}_2\rVert_2^2+\varepsilon^2}}
$$

$\tau$ 是截断阈值，经典HOG和Demo12使用 $0.2$。第一次归一化消除整体能量大小；截断限制单条特别强的边缘支配整个Block；截断会改变向量长度，因此第二次归一化恢复统一尺度。

以下代码来自 Demo08 的 `normalizeOverlappingBlocks()` 核心流程。Demo08将每个Block归一化后重新累计到Cell位置，最后除以该Cell参与的Block数量。

```cpp
// accumulatedFeature保存各Block回填到同一Cell后的总和。
// contributionCount保存每个Cell收到几次回填，用于最后求平均。
cv::Mat accumulatedFeature = cv::Mat::zeros(cellRows, cellColumns, CV_32FC(binCount_));
cv::Mat contributionCount = cv::Mat::zeros(cellRows, cellColumns, CV_32S);

for (int blockRow = 0; blockRow < cellRows - 1; ++blockRow) {
    for (int blockColumn = 0; blockColumn < cellColumns - 1; ++blockColumn) {
        std::vector<float> blockVector;
        blockVector.reserve(2 * 2 * binCount_); // 2×2个Cell，每个Cell有binCount个方向值。

        for (int cellOffsetY = 0; cellOffsetY < 2; ++cellOffsetY) {
            for (int cellOffsetX = 0; cellOffsetX < 2; ++cellOffsetX) {
                const float* histogram = cellHistograms.ptr<float>(
                    blockRow + cellOffsetY, blockColumn + cellOffsetX);
                blockVector.insert(blockVector.end(), histogram, histogram + binCount_);
            }
        }

        float squaredNorm = 0.0F;
        for (float value : blockVector) {
            squaredNorm += value * value; // 计算Block向量的平方和。
        }
        const float firstNorm = std::sqrt(squaredNorm + epsilon_ * epsilon_);

        for (float& value : blockVector) {
            value = std::min(value / firstNorm, clippingThreshold_); // 第一次归一化后截断。
        }

        squaredNorm = 0.0F;
        for (float value : blockVector) {
            squaredNorm += value * value; // 截断改变了向量长度，需要重新计算范数。
        }
        const float secondNorm = std::sqrt(squaredNorm + epsilon_ * epsilon_);
        for (float& value : blockVector) {
            value /= secondNorm; // 第二次归一化得到最终L2-Hys结果。
        }

        int vectorIndex = 0;
        for (int cellOffsetY = 0; cellOffsetY < 2; ++cellOffsetY) {
            for (int cellOffsetX = 0; cellOffsetX < 2; ++cellOffsetX) {
                const int cellRow = blockRow + cellOffsetY;
                const int cellColumn = blockColumn + cellOffsetX;
                float* destination = accumulatedFeature.ptr<float>(cellRow, cellColumn);

                for (int bin = 0; bin < binCount_; ++bin) {
                    destination[bin] += blockVector[vectorIndex++]; // 回填当前Block中的Cell值。
                }
                contributionCount.at<int>(cellRow, cellColumn) += 1;
            }
        }
    }
}

for (int cellRow = 0; cellRow < cellRows; ++cellRow) {
    for (int cellColumn = 0; cellColumn < cellColumns; ++cellColumn) {
        const int count = contributionCount.at<int>(cellRow, cellColumn);
        float* feature = accumulatedFeature.ptr<float>(cellRow, cellColumn);
        if (count > 0) {
            for (int bin = 0; bin < binCount_; ++bin) {
                feature[bin] /= static_cast<float>(count); // 得到唯一Cell位置的平均描述。
            }
        }
    }
}
```

## 5 OpenCV一维HOG描述子与二维HOG特征图

### 5.1 Demo07如何使用OpenCV HOGDescriptor

OpenCV的 `cv::HOGDescriptor` 已经实现了梯度计算、方向投票、Block滑动和L2-Hys归一化。它适合先确认参数含义和描述子长度，也适合目标检测中需要固定长度向量的场景。

Demo07默认使用以下参数：

| 参数 | 数值 | 含义 |
|---|---:|---|
| `winSize` | $64\times64$ | 输入图像固定尺寸 |
| `blockSize` | $16\times16$ | 每个Block包含 $2\times2$ 个Cell |
| `blockStride` | $8\times8$ | Block每次移动一个Cell |
| `cellSize` | $8\times8$ | 每个Cell覆盖的像素范围 |
| `nbins` | 9 | 无符号梯度方向数量 |

水平方向和垂直方向各有：

$$
N_{block}=\frac{64-16}{8}+1=7
$$

每个Block包含 $2\times2\times9=36$ 个数，因此总描述子长度为：

$$
7\times7\times36=1764
$$

以下代码来自 Demo07 的 `OpenCvHogExtractor` 构造函数第21—104行。构造函数创建OpenCV HOG对象，并验证窗口、Block、步长和Cell之间的整除关系。

```cpp
// 输入参数依次确定图像窗口、Block范围、Block步长、Cell范围和方向桶数量。
OpenCvHogExtractor::OpenCvHogExtractor(
    const cv::Size& windowSize,
    const cv::Size& blockSize,
    const cv::Size& blockStride,
    const cv::Size& cellSize,
    int orientationBins)
    : windowSize_(windowSize),
      blockSize_(blockSize),
      blockStride_(blockStride),
      cellSize_(cellSize),
      orientationBins_(orientationBins),
      hog_(windowSize,
           blockSize,
           blockStride,
           cellSize,
           orientationBins,
           1,                            // derivAperture：梯度算子的孔径。
           -1.0,                         // winSigma：让OpenCV自动选择高斯平滑参数。
           cv::HOGDescriptor::L2Hys,     // Block采用L2-Hys归一化。
           0.2,                          // L2-Hys截断阈值。
           true,                         // 使用gamma校正，压缩过亮区域的像素差异。
           64,                           // 检测层数；本Demo只提取特征，不使用多尺度检测。
           false)                        // false表示0°～180°无符号梯度。
{
    CV_Assert(windowSize_.width > 0 && windowSize_.height > 0);
    CV_Assert(blockSize_.width > 0 && blockSize_.height > 0);
    CV_Assert(blockStride_.width > 0 && blockStride_.height > 0);
    CV_Assert(cellSize_.width > 0 && cellSize_.height > 0);
    CV_Assert(orientationBins_ > 0);

    // Block必须由整数个Cell组成，否则每个Cell无法完整参与归一化。
    CV_Assert(blockSize_.width % cellSize_.width == 0);
    CV_Assert(blockSize_.height % cellSize_.height == 0);

    // 步长使用Cell尺寸的整数倍，保证相邻Block落在统一的Cell网格上。
    CV_Assert(blockStride_.width % cellSize_.width == 0);
    CV_Assert(blockStride_.height % cellSize_.height == 0);

    // 最后一个Block必须恰好落在窗口内部，不能越过winSize边界。
    CV_Assert((windowSize_.width - blockSize_.width) % blockStride_.width == 0);
    CV_Assert((windowSize_.height - blockSize_.height) % blockStride_.height == 0);
}
```

`HOGDescriptor::compute()`输出 `std::vector<float>`。它按照Block滑动顺序保存数据，同一个Cell在不同Block中的归一化值会重复出现。这个结果适合组成固定长度的分类描述子，但相关滤波需要保持“行、列、通道”的空间关系，因此还需要Demo08。

### 5.2 Demo08为什么自己实现二维HOG特征图

相关滤波响应图的每个位置代表一个二维位移。特征也必须保留空间位置。如果把1764个数只当作一维向量使用，就不容易说明某个数属于哪个Cell、哪个方向，也不方便对每个方向通道执行DFT。

Demo08自己实现HOG的目的有两个：

1. 保存 `cellRows × cellColumns × bins` 的三维布局。
2. 显示原始Cell直方图、Block归一化结果和汉明窗处理后的特征图。

对于 $64\times64$ 输入和 $8\times8$ Cell，Demo08输出 $8\times8\times9$。空间网格是 $8\times8$，每个位置有9个方向通道。

以下代码来自 Demo08 的 `CustomHogMapExtractor::extract()` 第394—469行。这里调用OpenCV完成基础数学操作，方向投票和Block回填仍由Demo08自己完成。

```cpp
// 输入imageWindow：已经裁剪并缩放到固定尺寸的搜索区域。
// 返回CustomHogResult：包含梯度、原始Cell直方图、归一化特征和最终加窗特征。
CustomHogResult CustomHogMapExtractor::extract(const cv::Mat& imageWindow) const
{
    CustomHogResult result;
    result.grayFloat = convertToGrayFloat(imageWindow); // 转为CV_32FC1，便于后续浮点计算。

    cv::Sobel(result.grayFloat, result.gradientX, CV_32F,
              1, 0, 1, 1.0, 0.0, cv::BORDER_REPLICATE); // 求水平方向中心差分。
    cv::Sobel(result.grayFloat, result.gradientY, CV_32F,
              0, 1, 1, 1.0, 0.0, cv::BORDER_REPLICATE); // 求垂直方向中心差分。

    // cartToPolar把(gx, gy)转换为幅值和角度；true表示角度单位为度。
    cv::cartToPolar(result.gradientX, result.gradientY,
                    result.magnitude, result.angleDegrees, true);

    // OpenCV返回0°～360°；普通HOG将相反梯度视为同一轮廓方向，折叠到0°～180°。
    for (int y = 0; y < result.angleDegrees.rows; ++y) {
        float* angleRow = result.angleDegrees.ptr<float>(y);
        for (int x = 0; x < result.angleDegrees.cols; ++x) {
            if (angleRow[x] >= 180.0F) {
                angleRow[x] -= 180.0F;
            }
        }
    }

    // 先按Cell累计9方向直方图，再用重叠Block执行L2-Hys归一化。
    result.rawCellHistograms = accumulateCellHistograms(
        result.magnitude, result.angleDegrees);
    result.normalizedFeature = normalizeOverlappingBlocks(
        result.rawCellHistograms);

    // 对9个方向通道使用同一张二维Hann窗，削弱循环相关在边缘处的拼接突变。
    result.feature = hann_window_demo::applyHannWindow(
        result.normalizedFeature, hannWindow_);
    return result;
}
```

`rawCellHistograms` 用于观察梯度投票，`normalizedFeature` 用于观察Block归一化，`feature` 才是能够直接交给后续相关滤波Demo的特征。

### 5.3 Demo07和Demo08的输出图怎样观察

Demo07主要输出以下图像：

- 原始图：检查输入中是否有水平、垂直和斜向边缘。
- 水平梯度图：亮处表示 $|g_x|$ 大，通常对应竖直边缘。
- 垂直梯度图：亮处表示 $|g_y|$ 大，通常对应水平边缘。
- 一维HOG描述子图：每条竖线代表描述子中的一个数值。它用于确认长度和数值变化，无法直接对应二维Cell位置。

Demo08的箭头图中，每个小格对应一个Cell。箭头方向表示该Cell中能量最大的方向桶，箭头长度或旁边数值表示该方向的累计强度。需要注意，梯度箭头垂直于可见边缘。

Block可视化显示每个 $2\times2$ Cell邻域的归一化强度。明亮Block说明该局部存在较强且集中的方向结构；暗Block说明局部较平坦。它的颜色只负责把数值大小映射成热力图，颜色本身不代表某个特定方向。方向信息位于不同通道中。

## 6 CC风格31通道FHOG特征图

### 6.1 FHOG固定特征几何是怎样得到的

CC风格Demo12把搜索区域统一成 $104\times104$，Cell大小为4。原始Cell网格为：

$$
104/4=26
$$

Block归一化需要相邻Cell。为了让最终特征的每个位置都具有完整的四周上下文，Demo12去掉最外侧一圈Cell，因此输出空间大小为：

$$
(26-2)\times(26-2)=24\times24
$$

最终特征尺寸为：

$$
24\times24\times31
$$

这里的固定尺寸服务于相关滤波模型。实际搜索区域在原图中可以随目标尺度变化，裁剪后会先缩放到 $104\times104$，因此滤波器始终处理 $24\times24\times31$。

以下代码来自 Demo12 第18—21行和特征几何函数第245—276行。它明确了通道数量、输入尺寸、原始Cell数量和最终Cell数量的关系。

```cpp
constexpr int kSignedOrientationCount = 18; // 0°～360°有符号方向通道。
constexpr int kUnsignedOrientationCount = 9; // 合并相反方向后的无符号通道。
constexpr int kTextureChannelCount = 4; // 四个Block归一化上下文通道。
constexpr int kFhogChannelCount = 31; // 18+9+4个逻辑通道。

// featureCells=24时，原始Cell网格额外保留一圈边界：26×26。
cv::Size CcFeatureGeometry::rawCellGridSize() const
{
    const int rawCells = featureCells + 2;
    return cv::Size(rawCells, rawCells);
}

// cellSize=4时，FHOG输入图像为(24+2)×4=104像素见方。
cv::Size CcFeatureGeometry::inputImageSize() const
{
    const int inputPixels = (featureCells + 2) * cellSize;
    return cv::Size(inputPixels, inputPixels);
}

// 去掉外围Cell后，相关滤波器实际看到24×24个空间位置。
cv::Size CcFeatureGeometry::featureMapSize() const
{
    return cv::Size(featureCells, featureCells);
}

// searchFactor把用户框、padding和固定FHOG几何换算成实际搜索区域倍率。
float CcFeatureGeometry::searchFactor() const
{
    const float inputPixels = static_cast<float>((featureCells + 2) * cellSize);
    const float formalFeaturePixels = static_cast<float>(featureCells * cellSize);
    return padding * inputPixels / formalFeaturePixels;
}
```

### 6.2 18个有符号方向通道怎样生成

有符号梯度保留 $0^\circ$ 到 $360^\circ$。18个方向通道的间隔为：

$$
360^\circ/18=20^\circ
$$

每个像素先选择BGR中梯度最强的通道，再向相邻两个方向桶和相邻四个Cell投票。方向插值减少角度边界跳变，空间插值减少目标移动不足一个Cell时的特征跳变。

以下代码来自 Demo12 的 `computeStrongestGradient()` 第295—454行核心部分。`cv::Sobel()`负责每个颜色通道的梯度，循环负责逐像素选择最大梯度能量。

```cpp
// 输入bgrFloat为CV_32FC3，输出magnitude和angleDegrees均为CV_32FC1。
std::vector<cv::Mat> colorChannels;
cv::split(bgrFloat, colorChannels); // OpenCV按B、G、R顺序拆成3张单通道图。

std::vector<cv::Mat> gradientX(3);
std::vector<cv::Mat> gradientY(3);
for (int channel = 0; channel < 3; ++channel) {
    cv::Sobel(colorChannels[channel], gradientX[channel], CV_32F,
              1, 0, 1, 1.0, 0.0, cv::BORDER_REPLICATE);
    cv::Sobel(colorChannels[channel], gradientY[channel], CV_32F,
              0, 1, 1, 1.0, 0.0, cv::BORDER_REPLICATE);
}

magnitude = cv::Mat::zeros(bgrFloat.size(), CV_32F);
angleDegrees = cv::Mat::zeros(bgrFloat.size(), CV_32F);

for (int y = 1; y < bgrFloat.rows - 1; ++y) {
    float* magnitudeRow = magnitude.ptr<float>(y);
    float* angleRow = angleDegrees.ptr<float>(y);
    for (int x = 1; x < bgrFloat.cols - 1; ++x) {
        float strongestEnergy = -1.0F;
        float strongestX = 0.0F;
        float strongestY = 0.0F;

        for (int channel = 0; channel < 3; ++channel) {
            const float gx = gradientX[channel].at<float>(y, x);
            const float gy = gradientY[channel].at<float>(y, x);
            const float energy = gx * gx + gy * gy;
            if (energy > strongestEnergy) {
                strongestEnergy = energy; // 保存该像素上边缘最清晰的颜色通道。
                strongestX = gx;
                strongestY = gy;
            }
        }

        magnitudeRow[x] = std::sqrt(std::max(strongestEnergy, 0.0F));
        float angle = std::atan2(strongestY, strongestX) * 180.0F /
                      static_cast<float>(CV_PI);
        if (angle < 0.0F) {
            angle += 360.0F; // FHOG有符号方向需要保留完整的0°～360°范围。
        }
        angleRow[x] = angle;
    }
}
```

### 6.3 9个无符号方向通道怎样得到

18个有符号方向中，相差 $180^\circ$ 的两个通道对应相同的边缘朝向、相反的亮暗变化。把这两个通道相加即可得到9个无符号方向：

$$
H_u(k)=H_s(k)+H_s(k+9),\qquad k=0,1,\ldots,8
$$

有符号方向能够区分边缘两侧的亮暗顺序，无符号方向对明暗翻转更稳定。FHOG同时保存两类信息，让后续相关滤波训练决定哪些通道更有用。

### 6.4 CC代码中的“4通道”究竟是什么

CC风格FHOG的31个通道由三部分组成：

$$
31=18\text{个有符号方向}+9\text{个无符号方向}+4\text{个纹理/归一化上下文通道}
$$

这里的“4通道”指最后4个纹理或归一化能量通道，来源于一个Cell在四个相邻Block上下文中的归一化结果。它们和B、G、R、灰度四种输入没有对应关系。BGR只在梯度计算时竞争，最终选出一组最强梯度。

有些SIMD实现会把31个逻辑通道补齐到32个存储槽，方便向量化访问。第32个槽属于内存布局填充，不构成新的FHOG特征。

可以先把这4个通道理解为：

> **我的理解：这4个通道主要观察同一个Cell在4个不同Block中归一化以后，它的总体梯度强度分别有多大。计算时，先把Cell的18个有符号方向合并成9个无符号方向，对这9个数平方求和得到Cell能量；一个Block中的4个Cell能量相加得到Block能量，再由Block能量得到归一化因子。当前Cell最多属于4个Block，所以会得到4个归一化因子。每个因子分别乘以当前Cell的18个有符号方向值并执行0.2截断，然后将18个结果求和并乘以 $1/\sqrt{18}$，最终得到4个纹理/归一化上下文通道。**

这段理解给出了完整计算主线。需要注意，最后一步属于“求和后缩放”，缩放系数为 $1/\sqrt{18}\approx0.2357$；18个数的算术平均系数则是 $1/18$。

### 6.5 详细计算4个纹理/归一化上下文通道

下面按照这条主线逐步计算。第一步先定义“能量”：它表示一组梯度方向直方图数值的平方和，用于衡量这组梯度整体有多强。它不表示像素亮度，也不表示阶段3-8频谱图中的频域能量。

Demo12先为每个Cell计算一份Cell能量。对于第 $o$ 个无符号方向，把相反的两个有符号方向相加：

$$
H_u(o)=H_s(o)+H_s(o+9)
$$

再把9个无符号方向值分别平方后相加：

$$
E_{cell}(x,y)=\sum_{o=0}^{8}H_u(x,y,o)^2
$$

$E_{cell}$ 就是这个Cell的9维无符号方向向量的平方长度。Cell中存在多条强边缘时，方向直方图数值较大，$E_{cell}$ 也较大；Cell接近平坦区域时，$E_{cell}$ 接近零。

以下代码来自 Demo12 的 `buildNormalizationEnergy()` 第618—668行。输出 `energy` 是一张单通道矩阵，每个位置保存对应Cell的 $E_{cell}$。

```cpp
// 输入signedCellHistograms：尺寸为rawRows×rawCols×18的有符号方向直方图。
// 返回energy：尺寸为rawRows×rawCols的单通道矩阵，每个元素是一项Cell能量。
cv::Mat CcFhogExtractor::buildNormalizationEnergy(
    const cv::Mat& signedCellHistograms) const
{
    if (signedCellHistograms.type() != CV_32FC(kSignedOrientationCount)) {
        throw std::invalid_argument(
            "buildNormalizationEnergy: expected 18-channel histograms.");
    }

    cv::Mat energy = cv::Mat::zeros(signedCellHistograms.size(), CV_32F);
    for (int y = 0; y < signedCellHistograms.rows; ++y) {
        const float* histogramRow = signedCellHistograms.ptr<float>(y);
        float* energyRow = energy.ptr<float>(y);

        for (int x = 0; x < signedCellHistograms.cols; ++x) {
            // histogram指向当前Cell的18个有符号方向值。
            const float* histogram = histogramRow + x * kSignedOrientationCount;
            float cellEnergy = 0.0F;

            for (int orientation = 0;
                 orientation < kUnsignedOrientationCount;
                 ++orientation) {
                // 合并相差180°的方向，得到当前无符号方向的数值。
                const float unsignedValue =
                    histogram[orientation] +
                    histogram[orientation + kUnsignedOrientationCount];

                // 9个无符号方向的平方和就是当前Cell的梯度能量。
                cellEnergy += unsignedValue * unsignedValue;
            }
            energyRow[x] = cellEnergy;
        }
    }
    return energy;
}
```

第二步计算Block能量。一个 $2\times2$ Block包含4个Cell，它的Block能量是这4个Cell能量之和：

$$
E_{block}=E_{cell}(x,y)+E_{cell}(x+1,y)+E_{cell}(x,y+1)+E_{cell}(x+1,y+1)
$$

第三步由Block能量计算归一化因子：

$$
n_q=\frac{1}{\sqrt{E_q+\varepsilon}},\qquad q\in\{0,1,2,3\}
$$

这里更准确的名称是“Block归一化因子”：$E_q$ 是第 $q$ 个Block的能量，$n_q$ 是该能量经过平方根后的倒数。方向直方图乘以 $n_q$，等价于用这个Block的整体梯度强度进行L2归一化。$\varepsilon$ 防止平坦Block的能量为零时发生除零。

以下代码来自 Demo12 的 `inverseBlockNorm()` 第48—61行。参数 `left`、`top` 表示这个 $2\times2$ Block左上角的Cell坐标。

```cpp
// energy：每个位置保存一项Cell能量；left、top：Block左上角Cell坐标。
// 返回值：这个2×2 Block的归一化因子1/sqrt(E_block+epsilon)。
float inverseBlockNorm(
    const cv::Mat& energy,
    int left,
    int top,
    float epsilon)
{
    // Block能量等于其中4个Cell能量之和。
    const float blockEnergy =
        energy.at<float>(top, left) +
        energy.at<float>(top, left + 1) +
        energy.at<float>(top + 1, left) +
        energy.at<float>(top + 1, left + 1);

    return 1.0F / std::sqrt(blockEnergy + epsilon);
}
```

第四步确定当前Cell对应的四个Block上下文。Block每次移动一个Cell，因此同一个Cell最多属于四个相互重叠的 $2\times2$ Block。对于坐标为 $(x,y)$ 的当前Cell，这四种关系为：

| 上下文索引 | Block左上角坐标 | 当前Cell位于该Block中的位置 |
|---:|---|---|
| 0 | $(x-1,y-1)$ | 右下角 |
| 1 | $(x,y-1)$ | 左下角 |
| 2 | $(x-1,y)$ | 右上角 |
| 3 | $(x,y)$ | 左上角 |

这里的“上下文”表示：**同一个Cell分别和哪三个邻居共同组成Block并进行归一化。** 四个Block包含的邻居不同，所以得到四个归一化因子 $n_0,n_1,n_2,n_3$。同一个方向值分别乘以这四个因子，会得到四份带有不同邻域信息的结果。

第五步使用四个归一化因子处理方向值。18个有符号方向通道和9个无符号方向通道会把四份归一化结果截断后相加：

$$
F_o=\frac{1}{2}\sum_{q=0}^{3}\min\left(H_o n_q,0.2\right)
$$

$0.2$ 截断限制一条特别强的边缘控制整个特征。前27个方向通道把四种上下文合并成一个数值，从而维持唯一的二维Cell网格。

第六步生成最后4个纹理/归一化上下文通道。它们分别保留四种上下文下的总体梯度强度。第 $q$ 个上下文通道的计算为：

$$
T_q=\frac{1}{\sqrt{18}}\sum_{o=0}^{17}
\min\left(H_s(o)n_q,0.2\right)
$$

$T_q$ 对18个有符号方向求和，所以它不再区分具体方向。它回答的是：**当前Cell放在第 $q$ 个Block邻域中归一化后，总共还保留了多少梯度结构。** `1/\sqrt{18}` 用于缩放18项累加后的数值范围，Demo12中的常量 `kTextureScale=0.23570226` 就是 $1/\sqrt{18}$。

这四个通道的作用可以用一个例子理解：当前Cell本身都有一条强竖直边缘，但它的左侧可能属于平坦背景，右侧可能还有目标内部的多条边缘。四个Block的能量不同，归一化后的 $T_0$ 到 $T_3$ 也不同。相关滤波器因此既能看到“当前Cell有什么方向”，也能看到“这段边缘处在怎样的局部纹理环境中”。

以下代码来自 Demo12 的 `buildFhog()` 第684—813行核心部分。代码依次构造18个有符号通道、9个无符号通道和4个上下文通道。

```cpp
// signedCellHistograms布局为rawRows×rawCols×18。
// normalizationEnergy保存6.5前文定义的Cell能量：9个无符号方向值的平方和。
const cv::Size outputSize = geometry_.featureMapSize();
cv::Mat fhog = cv::Mat::zeros(outputSize, CV_32FC(kFhogChannelCount));

for (int outputY = 0; outputY < outputSize.height; ++outputY) {
    const int rawY = outputY + 1; // 跳过原始网格最外侧一圈。
    float* outputRow = fhog.ptr<float>(outputY);

    for (int outputX = 0; outputX < outputSize.width; ++outputX) {
        const int rawX = outputX + 1;
        const float* histogram = signedCellHistograms.ptr<float>(rawY) +
                                 rawX * kSignedOrientationCount;
        float* outputFeature = outputRow + outputX * kFhogChannelCount;

        // 四个因子分别来自Block左上角(x-1,y-1)、(x,y-1)、(x-1,y)、(x,y)。
        // 它们表示当前Cell与四组不同邻居共同归一化时使用的缩放值。
        const float normalizationFactors[4] = {
            inverseBlockNorm(normalizationEnergy, rawX - 1, rawY - 1, geometry_.epsilon),
            inverseBlockNorm(normalizationEnergy, rawX,     rawY - 1, geometry_.epsilon),
            inverseBlockNorm(normalizationEnergy, rawX - 1, rawY,     geometry_.epsilon),
            inverseBlockNorm(normalizationEnergy, rawX,     rawY,     geometry_.epsilon)
        };

        for (int orientation = 0; orientation < 18; ++orientation) {
            float contextSum = 0.0F;
            for (float context : normalizationFactors) {
                // 每个上下文先归一化再截断，防止单条强边缘控制整个描述子。
                contextSum += clipFeature(histogram[orientation] * context,
                                          geometry_.clippingThreshold);
            }
            outputFeature[orientation] = 0.5F * contextSum; // 通道0～17：有符号方向。
        }

        for (int orientation = 0; orientation < 9; ++orientation) {
            const float unsignedValue = histogram[orientation] +
                                        histogram[orientation + kUnsignedOrientationCount];
            float contextSum = 0.0F;
            for (float context : normalizationFactors) {
                contextSum += clipFeature(unsignedValue * context,
                                          geometry_.clippingThreshold);
            }
            outputFeature[18 + orientation] = 0.5F * contextSum; // 通道18～26。
        }

        for (int contextIndex = 0; contextIndex < 4; ++contextIndex) {
            float textureEnergy = 0.0F;
            for (int orientation = 0; orientation < 18; ++orientation) {
                // 汇总当前上下文下18个方向的归一化结果；求和后不再保留具体方向。
                textureEnergy += clipFeature(
                    histogram[orientation] * normalizationFactors[contextIndex],
                    geometry_.clippingThreshold);
            }
            // 通道27～30分别保存四个Block邻域下的总体梯度结构强度。
            // kTextureScale=1/sqrt(18)，用于缩放18项累加后的数值范围。
            outputFeature[27 + contextIndex] = kTextureScale * textureEnergy;
        }
    }
}
```

### 6.6 Demo12的输出图和尺寸验证

Demo12应重点观察三类输出：

- 最强梯度幅值图：亮处表示BGR三个通道中存在强边缘，无法从颜色判断具体方向。
- 方向通道热力图：每张图只显示一个方向通道，亮处表示该位置含有较强的对应方向轮廓。
- FHOG能量图：通常把31个通道的平方和或绝对值和压缩成一张图，用于观察整体特征集中在哪里。

热力图中的紫、蓝、绿、黄、红只对应从低到高的数值映射。单独看颜色不能判断边缘朝向；必须先确认当前显示的是第几个方向通道。

尺寸验证应得到：输入 `104×104×3`、原始直方图 `26×26×18`、最终FHOG `24×24×31`。如果输出成了 $26\times26\times31$，说明没有裁掉缺少完整Block上下文的外围Cell；如果只有4通道，则混淆了最后四个上下文通道与完整FHOG通道数。

## 7 特征图分辨率与目标定位精度

### 7.1 Cell位移怎样换算回原图位移

相关滤波响应图与特征图使用相同的空间网格。响应峰值相对中心移动一个位置，代表特征图移动一个Cell。换回原图时需要同时考虑Cell尺寸和搜索区域缩放比例。

设原图中裁剪的搜索区域宽度为 $W_s$，送入特征提取器的固定宽度为 $W_m$，Cell宽度为 $c$。响应峰值相对中心移动 $\Delta u$ 个Cell，则原图水平方向位移为：

$$
\Delta x=\Delta u\cdot c\cdot\frac{W_s}{W_m}
$$

垂直方向同理：

$$
\Delta y=\Delta v\cdot c\cdot\frac{H_s}{H_m}
$$

例如搜索区域在原图中宽208像素，缩放到104像素，FHOG Cell为4像素。响应峰值右移2个Cell，对应原图位移为：

$$
2\times4\times\frac{208}{104}=16\text{像素}
$$

用户框决定搜索区域的中心、大小以及训练标签的宽度。真正参与相关运算的是整个搜索区域的特征图，因此响应图给出搜索区域内部的相对位移。

### 7.2 特征图缩小带来的精度损失与收益

Cell尺寸为4时，整数响应位置的基础步长是模型输入中的4像素。它会损失小于一个Cell的直接空间分辨率，但同时带来三个收益：

1. 把局部像素汇总为方向统计，降低噪声和单像素变化的影响。
2. 缩小DFT和逐通道相关运算的矩阵尺寸。
3. 使模型更关注轮廓分布，减少对精确纹理位置的依赖。

特征图缩小倍数不能直接等同于最终框只能按该倍数跳动。方向和空间投票已经包含插值，响应峰值附近还可以做亚像素估计。因此输出框可以获得比整数Cell更细的连续位置。

### 7.3 亚像素峰值估计怎样补偿整数Cell限制

响应图只在整数Cell位置保存响应值，真正的连续峰值可能落在两个Cell之间。亚像素峰值估计不会恢复FHOG已经丢失的图像细节，它根据整数峰值附近的响应曲线，继续估计峰顶的小数位置。

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

因此峰值位置估计为 $0.167$ 个Cell，而整数搜索只能得到位置 $0$。

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

$\delta$ 通常限制在 $[-0.5,0.5]$ 附近。水平方向和垂直方向分别计算后，特征图位移变为：

$$
\Delta u=(u_{peak}-u_{center})+\delta_x
$$

$$
\Delta v=(v_{peak}-v_{center})+\delta_y
$$

最后再使用7.1中的比例换回原图像素。亚像素估计假设峰值附近近似光滑且只有一个主要峰。遮挡或背景干扰产生多个相近峰值时，抛物线插值无法修复目标身份错误，此时还需要PSR、峰值阈值或更强的可靠性机制。

## 8 CSRT对普通KCF/FHOG的可靠性改进

### 8.1 普通KCF为什么还会学习到目标框中的背景

用户框通常是矩形，而目标轮廓很少恰好填满矩形。框住车辆时，四角可能包含道路和树枝；框住人体时，两腿之间和身体两侧也包含背景。搜索区域还会在用户框外继续扩展，为位移搜索保留空间。

Hann窗能够压低搜索区域最外侧的特征，但用户框内部的背景仍然存在。普通KCF把整个矩形特征图共同用于训练。只要某段背景在初始帧中稳定出现，滤波器就可能把它作为目标外观的一部分。目标经过树木时，树枝既可能形成强FHOG边缘，也可能逐渐进入在线模板，最终引起漂移。

FHOG提升了特征本身的稳定性，但它不会自动知道矩形中的哪些像素属于目标。CSRT在相关滤波基础上增加空间可靠性和通道可靠性，用于处理这一边界。

### 8.2 CSRT的空间可靠性是什么

空间可靠性用于描述模板中哪些位置更可能属于前景目标。CSRT可以根据目标框内外的颜色直方图估计前景概率，生成空间可靠性掩膜。掩膜中的高值区域允许相关滤波器重点学习，低值区域限制背景位置对滤波器的贡献。

设普通相关滤波器为 $w$，空间掩膜为 $m$，受约束滤波器可以理解为：

$$
w_{spatial}=m\odot w
$$

实际训练还要同时满足频域相关目标和空间约束。CSRT使用交替方向乘子法（Alternating Direction Method of Multipliers，ADMM）迭代求解这个受约束优化问题。Demo19中的 `admmIterations=8` 表示每次训练进行8次内部迭代。

空间可靠性主要减少矩形框内背景被持续学习的问题。当前景与背景颜色接近、目标很小或严重遮挡时，颜色分割仍可能不稳定，所以它提供的是可靠性约束，无法保证所有场景都得到准确轮廓。

### 8.3 CSRT的通道可靠性是什么

多通道特征对不同场景的作用不同。白车在灰色道路上可能依靠轮廓方向；颜色鲜明的车辆可能依靠Color Names或RGB；低照度场景中某些颜色通道噪声较大。

CSRT会为特征通道学习可靠性权重。通道 $c$ 的响应记为 $r_c$，融合响应可以表示为：

$$
r=\sum_{c=1}^{C}\beta_c r_c
$$

$\beta_c$ 是通道可靠性权重。响应峰值清晰、能够稳定区分目标与背景的通道获得更高权重；响应分散或容易产生干扰峰的通道权重会降低。Demo19的 `useChannelWeights=true` 开启这项功能，`weights_lr` 控制权重随新帧更新的速度。

空间可靠性回答“特征图中哪些位置可信”，通道可靠性回答“哪些特征通道可信”。两者约束的维度不同，可以同时使用。

### 8.4 HOG、Color Names、灰度和RGB怎样共同参与CSRT

Demo19同时启用四类外观信息：

| 特征 | 主要信息 | 容易受影响的情况 |
|---|---|---|
| HOG | 轮廓和局部方向 | 强遮挡、目标轮廓变化 |
| Color Names | 颜色语义通道 | 前景与背景颜色接近 |
| 灰度 | 亮度结构 | 曝光和阴影变化 |
| RGB | 原始颜色差异 | 光照色温变化、颜色噪声 |

Color Names把RGB颜色映射到若干具有语义的颜色响应通道，例如红、绿、蓝等颜色倾向。它比直接RGB更紧凑，也能补充HOG缺少的颜色信息。CSRT对各类通道分别提取特征、计算响应，再利用通道权重融合。

增加通道能够提高复杂场景的表达能力，也会增加特征提取、DFT、滤波训练和内存访问成本。无人机端需要同时测量跟踪稳定性和单帧耗时，不能只按通道数量判断效果。

### 8.5 Demo19的HY风格CSRT参数与实际边界

Demo19只复刻HY中直接使用OpenCV CSRT的部分。默认配置为：

| 配置 | Demo19数值 | 作用 |
|---|---:|---|
| `use_hog` | `true` | 使用HOG轮廓特征 |
| `use_color_names` | `true` | 使用Color Names颜色特征 |
| `use_gray` | `true` | 使用灰度特征 |
| `use_rgb` | `true` | 使用RGB特征 |
| `use_channel_weights` | `true` | 学习通道可靠性 |
| `use_segmentation` | `true` | 估计空间可靠性掩膜 |
| `template_size` | `120` | 内部模板的标准尺寸 |
| `gsl_sigma` | `0.8` | 训练标签高斯响应宽度 |
| `hog_orientations` | `12` | HOG方向数量 |
| `hog_clip` | `0.15` | HOG截断阈值 |
| `padding` | `1.5` | 用户框外搜索范围 |
| 三类学习率 | `0.10` | 滤波器、通道权重、颜色直方图更新速度 |
| `num_hog_channels_used` | `12` | 参与跟踪的HOG通道数 |
| `admm_iterations` | `8` | 空间约束训练迭代次数 |
| `histogram_bins` | `8` | 前景/背景颜色直方图桶数 |

以下代码来自 Demo19 的 `makeParameters()` 第35—87行。它把学习层的配置转换为OpenCV `TrackerCSRT::Params`，并保留HY对不同初始框尺寸的特征选择规则。

```cpp
// initialBox用于选择HY的ROI特征配置；返回值交给TrackerCSRT::create()。
cv::TrackerCSRT::Params HyCsrtTracker::makeParameters(
    const cv::Rect& initialBox) const
{
    cv::TrackerCSRT::Params params; // 未覆盖的字段继续使用OpenCV 4.10默认值。

    params.use_hog = config_.useHog;
    params.use_color_names = config_.useColorNames;
    params.use_gray = config_.useGray;
    params.use_rgb = config_.useRgb;
    params.use_channel_weights = config_.useChannelWeights;
    params.use_segmentation = config_.useSegmentation;

    // HY的32/64像素ROI关闭颜色分割，保留其余特征。
    if (config_.useHyRoiFeatureProfile &&
        (std::abs(initialBox.width - 32) <= 1 ||
         std::abs(initialBox.width - 64) <= 1)) {
        params.use_segmentation = false;
    }
    // HY的128像素ROI只使用HOG和灰度，并继续学习通道权重。
    else if (config_.useHyRoiFeatureProfile &&
             std::abs(initialBox.width - 128) <= 1) {
        params.use_hog = true;
        params.use_color_names = false;
        params.use_gray = true;
        params.use_rgb = false;
        params.use_channel_weights = true;
        params.use_segmentation = false;
    }

    params.window_function = "hann"; // 衰减特征图边缘，减轻循环边界突变。
    params.template_size = config_.templateSize;
    params.gsl_sigma = config_.gaussianLabelSigma;
    params.hog_orientations = config_.hogOrientations;
    params.hog_clip = config_.hogClip;
    params.padding = config_.padding;

    // HY初始化时把滤波器、通道权重和颜色直方图设为同一个学习率。
    params.filter_lr = config_.learningRate;
    params.weights_lr = config_.learningRate;
    params.histogram_lr = config_.learningRate;
    params.num_hog_channels_used = config_.hogChannelsUsed;
    params.admm_iterations = config_.admmIterations;
    params.histogram_bins = config_.histogramBins;

    if (config_.disableScaleSearch) {
        params.number_of_scales = 0; // 关闭OpenCV内部尺度滤波后，CSRT只更新中心位置。
    }
    // 默认disableScaleSearch=false，保留OpenCV的尺度搜索，使框宽高能够变化。
    return params;
}
```

HY完整工程的正常分支可以关闭CSRT内部尺度搜索，并由外围 `scaleTrack()` 处理框大小。Demo19没有实现外围尺度模块，所以默认 `disableScaleSearch=false`。如果把它改成 `true`，绿色框会跟随中心移动，但宽高保持初始化值；这正是“物体从小到大，框大小没有变化”的直接原因。

以下代码来自 Demo19 的 `initialize()` 和 `update()` 第89—160行。OpenCV在 `update()` 内部完成本帧特征提取、定位、尺度估计和在线模型更新，Demo19只管理输入检查、异常和最后一次有效框。

```cpp
// frame是首帧，initialBox是用户框。成功后tracker_拥有该目标的CSRT模型。
bool HyCsrtTracker::initialize(const cv::Mat& frame, const cv::Rect& initialBox)
{
    reset();
    if (frame.empty()) {
        return false; // 空图无法提取特征，跟踪器保持未初始化状态。
    }

    currentBox_ = clampBoxToFrame(initialBox, frame.size());
    if (currentBox_.width < 2 || currentBox_.height < 2) {
        currentBox_ = cv::Rect();
        return false; // 裁剪后框过小，拒绝创建无效模型。
    }

    try {
        const cv::TrackerCSRT::Params params = makeParameters(currentBox_);
        tracker_ = cv::TrackerCSRT::create(params); // 每个新目标创建独立CSRT状态。
        tracker_->init(frame, currentBox_);         // 提取首帧特征并训练初始模型。
        initialized_ = true;
    }
    catch (const cv::Exception& exception) {
        std::cerr << "Demo19 CSRT initialize failed: " << exception.what() << '\n';
        reset(); // 创建或训练失败时清除半初始化状态，调用方需要重新选框。
    }
    return initialized_;
}

// 输入下一帧；返回成功标志、目标框和TrackerCSRT::update()耗时。
HyCsrtResult HyCsrtTracker::update(const cv::Mat& frame)
{
    HyCsrtResult result;
    result.box = currentBox_;
    if (!initialized_ || tracker_.empty() || frame.empty()) {
        return result; // 输入无效时success保持false，框保留最后有效位置。
    }

    cv::Rect detectedBox = currentBox_;
    const auto beginTime = std::chrono::steady_clock::now();
    try {
        result.success = tracker_->update(frame, detectedBox);
    }
    catch (const cv::Exception& exception) {
        std::cerr << "Demo19 CSRT update failed: " << exception.what() << '\n';
        result.success = false;
    }
    const auto endTime = std::chrono::steady_clock::now();
    result.elapsedMilliseconds =
        std::chrono::duration<double, std::milli>(endTime - beginTime).count();

    if (result.success) {
        detectedBox = clampBoxToFrame(detectedBox, frame.size());
        if (detectedBox.width >= 2 && detectedBox.height >= 2) {
            currentBox_ = detectedBox; // 仅让合法的成功结果覆盖内部最后位置。
        }
        else {
            result.success = false;
        }
    }

    result.box = currentBox_; // 失败时仍返回最后一次成功框，便于界面显示丢失位置。
    return result;
}
```

Demo19的边界也很明确：它没有包含HY外围的光流校验、HOG相似度判断、Kalman平滑、异常保护和重识别。测试结果只能评价OpenCV CSRT加上述参数的行为，不能代表HY完整工程的全部逻辑。

### 8.6 KCF/FHOG与CSRT怎样选择

| 对比项 | KCF/FHOG | CSRT |
|---|---|---|
| 主要特征 | 常用FHOG，可扩展其他通道 | HOG、Color Names、灰度、RGB等 |
| 背景约束 | 主要依靠训练标签和Hann窗 | 增加空间可靠性掩膜 |
| 通道处理 | 通常直接求和或统一训练 | 学习通道可靠性权重 |
| 尺度 | 需要额外尺度搜索或独立尺度滤波 | OpenCV实现内置尺度滤波，可配置关闭 |
| 计算量 | 较低，更适合高帧率嵌入式运行 | 较高，特征、分割和ADMM都增加耗时 |
| 遮挡与复杂背景 | 容易把遮挡物更新进模板 | 通常更稳，严重遮挡下仍可能失败 |

无人机端要求低延迟且目标外观相对稳定时，KCF加FHOG更容易控制计算量，也便于针对芯片做FFT、SIMD和内存布局优化。目标框含有较多背景、颜色信息明显且设备能够接受更高计算量时，CSRT的空间和通道可靠性更有价值。

两者都属于在线相关滤波跟踪器。它们都会受到完全遮挡、长时间离开画面和错误模板更新的影响。尺度更新、模板更新条件、响应质量判断和遮挡保护将在阶段3-10的完整万物跟踪流程中继续组织。
