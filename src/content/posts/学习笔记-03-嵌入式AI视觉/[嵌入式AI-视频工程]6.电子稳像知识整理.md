---
title: '[嵌入式AI-视频工程] 电子稳像知识整理'
published: 2026-09-24T08:15:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍电子稳像知识整理的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '视频处理', 'Linux']
category: '嵌入式AI-视频工程'
draft: false
lang: zh_CN
---

# 阶段2-6 电子稳像知识整理

## 1 电子稳像的基本原理与主要技术路线

电子稳像（Electronic Image Stabilization，EIS）通过数字图像处理减小视频中由相机抖动造成的画面晃动。最常见的流程只有三步：估计相机运动、平滑运动轨迹、根据平滑结果变换画面。

```text
相邻视频帧
→ 估计画面怎样移动
→ 累计得到相机运动轨迹
→ 平滑轨迹中的快速抖动
→ 计算补偿量并变换当前帧
```

运动估计决定算法看到了什么运动；轨迹平滑决定哪些运动需要保留；运动补偿负责生成最终画面。这三步中任意一步发生错误，都会表现为残余抖动、画面漂移、局部拉扯或黑边增大。

### 1.1 运动估计、轨迹平滑与运动补偿

设相机从视频开始到第 \(t\) 帧的累计运动为 \(C_t\)，平滑后的目标轨迹为 \(S_t\)。当前帧需要施加的补偿变换为：

$$
K_t=S_tC_t^{-1}
$$

\(C_t^{-1}\)先抵消原来的相机运动，\(S_t\)再把画面放到平滑后的目标位置。实际程序可以使用矩阵，也可以把相似变换拆成横向位移 \(x\)、纵向位移 \(y\) 和旋转角 \(a\) 进行累计与平滑。

平滑不能简单地把所有运动都压到零。缓慢转动相机拍摄新区域通常属于拍摄者的主动运动；手抖通常表现为叠加在轨迹上的快速、小幅往复变化。滤波器需要压制后者，同时跟随前者。

### 1.2 基于全局运动估计的整帧稳像

全局稳像为一对相邻帧估计一组统一的运动参数，然后用同一个变换处理整张图像。例如，相似变换使用一组平移、旋转和等比例缩放参数。

它的计算量较小，容易在CPU上实现，适合远景占主导、景深变化不大、滚动快门形变较弱的视频。画面含明显近景与远景时，相机移动会使不同深度区域产生不同位移，一组矩阵无法同时对齐所有区域。

### 1.3 基于局部运动估计的网格稳像

局部稳像把画面划分成网格，为不同网格估计各自的运动，再移动网格控制点并对内部像素插值。它可以处理视差、滚动快门形变和不同区域抖动幅度不一致的问题。

每个网格独立移动会造成相邻区域断裂，因此局部稳像通常同时施加两类约束：

- 时间约束：同一个控制点在连续帧中的轨迹要平滑。
- 空间约束：同一帧中的相邻控制点不能突然产生差异很大的位移。

局部路线需要更多可靠的像素对应关系，计算量和参数量也更大。当前景物体本身在运动时，还要避免把物体运动当成相机抖动写入网格。

### 1.4 陀螺仪辅助稳像与三维稳像

陀螺仪直接测量相机角速度。程序根据时间戳把角速度积分成旋转，并与每帧曝光时间对应起来。它不依赖图像纹理，在模糊或暗光画面中仍能提供旋转信息；传感器偏置、时间不同步和相机—陀螺仪外参误差会直接造成补偿错误。

三维稳像进一步估计相机在三维空间中的位姿和场景深度，然后选择一条平滑的虚拟相机轨迹并重建画面。它更适合存在明显视差的场景，但深度、位姿和新视角渲染都会增加计算量。Deep3D Stabilizer就是结合深度与相机自身运动进行三维重建和稳像的研究方法。[CVPR 2021论文](https://openaccess.thecvf.com/content/CVPR2021/html/Lee_3D_Video_Stabilization_With_Depth_Estimation_by_CNN-Based_Optimization_CVPR_2021_paper.html)

### 1.5 视频重建与端到端神经网络稳像

重建式稳像根据前后多帧合成当前稳定帧。网络可以预测逐像素变形场、虚拟相机姿态或最终稳定图像，因此能够覆盖传统流程中的多个环节。

这类方法可以利用更大的时空范围，在复杂视差和大幅抖动下有更高的效果上限，同时带来模型推理、显存、训练数据、时延和目标平台部署成本。例如，DMBVS一类方法直接从相邻视频帧合成稳定帧；Deep Online Fused Video Stabilization同时使用陀螺仪、光流和姿态历史预测虚拟相机姿态及变形网格。[WACV 2022论文](https://openaccess.thecvf.com/content/WACV2022/html/Shi_Deep_Online_Fused_Video_Stabilization_WACV_2022_paper.html)

## 2 电子稳像方法及其处理范围

### 2.1 全局路线和局部路线都可使用的特征与像素对应方法

两条路线首先都要取得相邻帧中同一场景位置的对应关系。区别从对应关系的使用方式开始：全局路线用全部有效对应点求一组整帧参数；局部路线保留对应点所在位置，求多个网格点的运动。

| 方法 | 输出 | 速度与特点 |
| --- | --- | --- |
| Shi–Tomasi + LK | 少量角点在下一帧中的位置 | CPU速度快，适合连续视频 |
| ORB | 关键点和二进制描述子 | CPU匹配较快，可重新建立跨帧对应 |
| SIFT | 关键点和浮点描述子 | 较慢，对尺度和旋转变化更稳健 |
| 稠密传统光流 | 大量像素的二维位移 | 局部信息丰富，计算量高于稀疏LK |
| SuperPoint | 学习得到的关键点和描述子 | 通常需要GPU或NPU，后续仍需匹配和运动估计 |
| RAFT | 每个像素的二维光流 | 适合给局部网格提供稠密运动，后续仍需平滑和补偿 |

SuperPoint覆盖特征检测和描述子生成。[SuperPoint论文](https://openaccess.thecvf.com/content_cvpr_2018_workshops/w9/html/DeTone_SuperPoint_Self-Supervised_Interest_CVPR_2018_paper.html) LightGlue接收两帧的局部特征并输出匹配关系，可以接在SuperPoint或SIFT后面。[LightGlue论文](https://openaccess.thecvf.com/content/ICCV2023/html/Lindenberger_LightGlue_Local_Feature_Matching_at_Light_Speed_ICCV_2023_paper.html) RAFT输出稠密光流，替换像素运动测量环节。[RAFT论文](https://openaccess.thecvf.com/content_ECCV_2020/html/Teed_RAFT_Recurrent_All-Pairs_Field_Transforms_for_Optical_Flow_ECCV_2020_paper.html)

### 2.2 全局稳像使用的估计、平滑与补偿方法

全局路线为每帧保存一组平移、旋转、缩放或单应参数。RANSAC、ECC和陀螺仪都可以提供全局运动；移动平均、高斯滤波、指数移动平均、Kalman滤波和优化方法可以平滑累计轨迹；`warpAffine()`或`warpPerspective()`将补偿矩阵应用到整帧。第4节按这条顺序完整说明。

### 2.3 局部稳像使用的估计、平滑与补偿方法

本文的局部路线采用MeshFlow：先把特征点残差传播给附近网格顶点，通过两次中值滤波得到空间平滑的网格运动；随后累计同一顶点的逐帧运动，并使用PAPS沿时间平滑vertex profile；最后根据原始轨迹和平滑轨迹之差变形画面。第5节按这条流程展开。

### 2.4 同时覆盖运动估计、轨迹平滑或补偿的多阶段AI稳像模型

只有覆盖多个稳像阶段的模型才归入这一类。阅读论文或选择方案时，应检查模型实际输入和输出，避免只根据“AI稳像”名称判断范围。

| 方法示例 | 输入与输出 | 覆盖范围 |
| --- | --- | --- |
| Learning Video Stabilization Using Optical Flow | 输入视频光流，输出逐像素稳定变形场 | 局部运动建模、路径处理和补偿场预测 |
| Deep Online Fused Video Stabilization | 输入陀螺仪、光流和姿态历史，输出虚拟姿态及变形网格 | 多源运动融合、在线路径预测和补偿 |
| Deep3D Stabilizer | 估计深度与相机运动并重建稳定视角 | 三维运动、轨迹平滑和新视角生成 |
| 前馈稳定帧合成网络 | 输入相邻多帧，输出稳定帧 | 将多个传统阶段合入图像合成网络 |

学习式方法需要在目标分辨率、目标硬件和目标场景上同时测量画面稳定度、几何畸变、裁剪量、单帧耗时和峰值内存。论文中的桌面GPU速度不能直接代表嵌入式NPU或CPU的表现。

## 3 LK光流的点运动计算原理

LK光流在两帧之间跟踪一组点，输出每个点在下一帧中的坐标。它在本节只完成点位移计算；第4节利用这些点位移估计全局运动，第5节利用它们估计局部网格运动。

### 3.1 从特征点窗口到待求位移

一块完全平坦的区域向任意方向移动后外观都相似，无法确定移动方向。一条直边沿自身方向移动也很难判断。角点在横向和纵向都有明显灰度变化，因此可以同时约束两个方向的位移。

Shi–Tomasi在每个局部窗口中计算灰度梯度，并形成矩阵：

$$
G=
\begin{bmatrix}
\sum I_x^2 & \sum I_xI_y\\
\sum I_xI_y & \sum I_y^2
\end{bmatrix}
$$

`Ix、Iy`是窗口内每个像素的横向和纵向灰度梯度，求和覆盖整个窗口。矩阵的两个特征值都较大，说明窗口在两个方向上都有足够的灰度变化，适合跟踪。`goodFeaturesToTrack()`可以按这个准则选点，并通过最小点距避免角点集中在一个小区域。

### 3.2 亮度恒定和小位移如何产生一个像素方程

LK光流假设同一个场景点在相邻帧中的亮度基本不变。前一帧位于 \((x,y)\) 的点移动 \((u,v)\) 后，在后一帧位于 \((x+u,y+v)\)：

$$
I_1(x,y)=I_2(x+u,y+v)
$$

\(u、v\)分别是待求的横向和纵向位移。因为 \(u、v\) 很小，可以把后一帧在 \((x,y)\) 附近的灰度写成一阶近似：

$$
I_2(x+u,y+v)\approx I_2(x,y)+I_xu+I_yv
$$

代回亮度恒定式并整理：

$$
I_xu+I_yv=-I_t,\qquad I_t=I_2(x,y)-I_1(x,y)
$$

这一行方程的已知量都能从两帧图像算出。用最简单的中心差分表示，在像素 \((x,y)\) 处可以计算：

$$
I_x\approx\frac{I(x+1,y)-I(x-1,y)}{2},\qquad
I_y\approx\frac{I(x,y+1)-I(x,y-1)}{2}
$$

两帧同一坐标的差给出时间变化：

$$
I_t=I_2(x,y)-I_1(x,y)
$$

因此 \(I_x、I_y、I_t\) 都是已知数，未知量只剩 \(u、v\)。一个像素只有一行方程，所以还不能解出两个未知量。

### 3.3 用窗口内多个像素组成方程组并求出位移

LK再增加一个局部假设：特征点周围小窗口内的像素共享同一个位移 \((u,v)\)。若窗口中有 \(n\) 个像素，每个像素都能生成3.2节的一行方程：

$$
\underbrace{
\begin{bmatrix}
I_{x1} & I_{y1}\\
I_{x2} & I_{y2}\\
\vdots & \vdots\\
I_{xn} & I_{yn}
\end{bmatrix}}_{A}
\underbrace{\begin{bmatrix}u\\v\end{bmatrix}}_{\boldsymbol d}
=
\underbrace{-\begin{bmatrix}I_{t1}\\I_{t2}\\\vdots\\I_{tn}\end{bmatrix}}_{\boldsymbol b}
$$

现在有 \(n\) 行方程和两个未知量。受噪声和线性近似误差影响，这些方程通常没有完全相同的交点。最小二乘法寻找让所有方程总误差最小的位移：

$$
\boldsymbol d^*=\arg\min_{\boldsymbol d}\|A\boldsymbol d-\boldsymbol b\|_2^2
$$

令目标函数的导数为零，得到正规方程及其解：

$$
A^TA\boldsymbol d=A^T\boldsymbol b
$$

$$
\begin{bmatrix}u\\v\end{bmatrix}
=
\begin{bmatrix}
\sum I_x^2 & \sum I_xI_y\\
\sum I_xI_y & \sum I_y^2
\end{bmatrix}^{-1}
\begin{bmatrix}-\sum I_xI_t\\-\sum I_yI_t\end{bmatrix}
$$

这一步直接给出特征点的二维位移。前一帧特征点为 \(p=(x,y)\)，后一帧位置就是：

$$
q=p+\boldsymbol d=(x+u,y+v)
$$

左侧的 \(A^TA\) 正好是3.1节的 \(G\)。角点的 \(G\) 在两个方向上都包含信息，矩阵才能稳定求逆。

实际LK会从当前位移估计出发，把后一帧窗口采样到估计位置，计算剩余灰度误差，再求一个增量 \(\Delta\boldsymbol d\)：

$$
\boldsymbol d^{(k+1)}=\boldsymbol d^{(k)}+\Delta\boldsymbol d
$$

迭代在增量足够小或达到最大次数时停止。一次线性求解只适合极小位移，迭代负责逐步对准亚像素位置。

亮度突变、运动模糊、窗口跨越两个不同运动物体或点移出画面时，上述假设会被破坏。`status`只能报告算法是否得到有效跟踪结果，应用还要使用误差、前后向检查和后续RANSAC继续筛选。

### 3.4 图像金字塔处理较大位移

小运动假设要求点在相邻帧中的位移不能远超局部窗口。图像金字塔逐层缩小图像，使原图中的大位移在低分辨率层变成小位移。

程序先在最小图层估计粗位移，再把结果放大到上一层作为初值并执行3.3节的迭代修正，直到回到原始分辨率。若相邻层宽高缩小一半，则从第 \(l\) 层进入第 \(l-1\) 层时：

$$
\boldsymbol d_{l-1}^{(0)}=2\boldsymbol d_l
$$

例如，原图32像素的位移经过三次缩小后只剩4像素，低层先求出约4像素，再逐层放大并修正为原图位移。

### 3.5 calcOpticalFlowPyrLK的输入、输出、status与err

OpenCV的`cv::calcOpticalFlowPyrLK()`计算稀疏金字塔LK光流。核心参数含义如下：

```cpp
cv::calcOpticalFlowPyrLK(
    previous_gray,     // 前一帧灰度图
    current_gray,      // 当前帧灰度图
    previous_points,   // 前一帧待跟踪点
    current_points,    // 输出：各点在当前帧中的坐标
    status,            // 输出：每个点是否跟踪成功，1表示成功
    error,             // 输出：每个点的跟踪误差
    cv::Size(21, 21),  // 每层金字塔中的局部搜索窗口
    3);                // 最高金字塔层级，0表示只使用原图
```

`previous_points[i]`、`current_points[i]`、`status[i]`和`error[i]`属于同一个跟踪点。应用筛选点时必须保持这些索引关系。

### 3.6 前后向检查过滤跟踪失败的点

前后向检查先从前一帧跟踪到当前帧，再把结果从当前帧跟踪回前一帧。设原始点为 \(p\)，前向结果为 \(q\)，反向结果为 \(p'\)，检查距离为：

$$
e_{FB}=\|p-p'\|_2
$$

距离超过阈值的点被丢弃。阈值单位是原图像素，例如`1.5`表示回到原点的误差最多允许1.5像素。分辨率、模糊程度和后续运动模型会影响合适阈值，需要通过真实视频调整。

### 3.7 动态物体、遮挡、模糊与低纹理造成的光流失败

- 动态物体：点被正确跟踪，但位移属于物体自身运动，不能直接代表相机运动。
- 遮挡：前一帧中的点在当前帧消失，跟踪会跳到附近相似纹理或失败。
- 模糊：局部灰度梯度变弱，角点位置和光流解变得不稳定。
- 低纹理：窗口中的两个特征值过小，无法可靠求出二维位移。
- 大位移：位移超出金字塔和窗口可搜索范围，结果会丢失或落到错误位置。

可以把通过前后向检查的点画在视频上。若点集中在运动物体、只分布在画面一角或在抖动时大量消失，应先修正特征分布、遮罩区域、金字塔层数或重新检测策略。

## 4 全局运动估计、轨迹平滑与整帧补偿

全局路线把一帧画面看作统一运动的平面。输入是跨帧对应点，运动估计输出一组整帧变换，轨迹平滑处理这组变换的累计结果，补偿阶段再用一张矩阵变换整帧。

### 4.1 RANSAC根据光流点对估计全局运动

随机采样一致性（Random Sample Consensus，RANSAC）反复执行三步：随机抽取足够数量的点对求一个候选模型、计算所有点对在该模型下的重投影误差、记录误差低于阈值的内点。最终使用内点最多的候选结果重新估计模型。

例如，`estimateAffinePartial2D()`可以从点对估计相似变换，并用RANSAC过滤不符合整帧运动的点：

```cpp
cv::Mat inlier_mask;
cv::Mat transform = cv::estimateAffinePartial2D(
    previous_points,
    current_points,
    inlier_mask,
    cv::RANSAC,
    3.0);  // 当前点与模型预测位置相差不超过3个像素时可作为内点
```

这里的`3.0`单位是输入图像像素。阈值太小会丢掉含噪声的真实背景点，太大会让动态物体或错误光流进入模型。程序还应检查变换矩阵是否为空、内点数量和内点比例；只有少数内点支持的矩阵不适合继续累计。

### 4.2 平移、相似、仿射与单应全局运动模型

| 模型 | 参数能力 | 最少点数 | 适用情况与风险 |
| --- | --- | --- | --- |
| 平移 | 横向、纵向平移 | 1对 | 固定焦距且旋转很小时稳定，表达能力最低 |
| 相似 | 平移、旋转、等比例缩放 | 2对 | 手持视频常用，参数少且不易产生剪切 |
| 仿射 | 相似变换加非等比例缩放和剪切 | 3对 | 能拟合更多二维变化，也更容易吸收局部物体运动 |
| 单应 | 平面透视映射，8个自由度 | 4对 | 近平面场景或纯旋转；视差明显时会局部错位 |

以Demo使用的相似变换为例，一个前一帧点 \(p_i=(x_i,y_i)^T\) 与当前帧点 \(q_i\) 满足：

$$
q_i=
\begin{bmatrix}
s\cos\theta & -s\sin\theta\\
s\sin\theta & s\cos\theta
\end{bmatrix}p_i+
\begin{bmatrix}t_x\\t_y\end{bmatrix}
$$

待求参数为缩放 \(s\)、旋转角 \(\theta\) 和平移 \(t_x、t_y\)。RANSAC先确定内点，`estimateAffinePartial2D()`再根据内点求出对应的 \(2\times3\) 矩阵。

模型自由度越高，拟合残差通常越小，但错误点对结果的影响也更大。普通手持视频可先用相似模型；确认它无法表达实际画面运动后，再比较仿射、单应或局部网格。

### 4.3 相邻帧全局运动与累计相机轨迹

相邻帧变换 \(T_t\) 只表示第 \(t-1\) 帧到第 \(t\) 帧的运动。累计轨迹需要按时间顺序组合：

$$
C_t=T_tC_{t-1}
$$

矩阵乘法顺序与坐标定义必须统一。本文Demo使用相似变换的近似参数累计：每帧从矩阵提取`dx、dy、da`，然后分别加到`x、y、a`。这种实现适合相邻帧变化较小的入门例子；严格处理缩放及较大旋转时应直接累计齐次矩阵。

### 4.4 全局相机轨迹的离线平滑与在线平滑

离线程序可以访问未来帧。半径为 \(r\) 的居中移动平均为：

$$
S_t=\frac{1}{N_t}\sum_{k=\max(0,t-r)}^{\min(T-1,t+r)}C_k
$$

\(N_t\) 是实际参与平均的帧数，序列中间通常为 \(2r+1\)。它需要未来 \(r\) 帧，因此输出延迟约为 \(r\) 帧。

在线程序只能使用当前和历史状态，可使用指数移动平均或Kalman滤波。指数移动平均为：

$$
S_t=\alpha C_t+(1-\alpha)S_{t-1}
$$

\(\alpha\) 越大，结果越快跟随当前轨迹，保留的快速变化也越多；\(\alpha\) 越小，画面更稳，主动转动时的滞后更明显。Kalman滤波则把位置和速度组成状态，用运动模型预测下一时刻，再根据当前观测修正预测；它适合在线处理，但需要设置过程噪声和观测噪声。

### 4.5 全局轨迹中的抖动与主动运镜

稳像算法通常根据时间频率和持续性区分二者：快速往复、持续时间短的变化更像抖动；持续同方向的平移或旋转更像主动运镜。这只是滤波假设，无法从一条短轨迹中永远准确判断拍摄意图。

窗口过短会留下抖动，窗口过长会压制主动运镜并造成画面长时间追赶。实际系统还可根据角速度、运动方向持续时间和裁剪余量动态调整平滑强度。

### 4.6 从平滑全局轨迹计算整帧补偿矩阵

当轨迹拆成 \(x、y、a\) 时，每帧补偿量为：

$$
\Delta x_t=x_t^{smooth}-x_t,\qquad
\Delta y_t=y_t^{smooth}-y_t,\qquad
\Delta a_t=a_t^{smooth}-a_t
$$

把补偿量加回当前相邻帧变换，得到用于`warpAffine()`的稳定变换。严格矩阵形式使用第1.1节的 \(K_t=S_tC_t^{-1}\)。

### 4.7 全局补偿产生的黑边、裁剪与缩放

画面被平移或旋转后，输出画布中的部分位置找不到输入像素，于是出现黑边。常见处理包括：

- 固定裁掉四周一圈，再缩放回原分辨率。
- 根据一段视频中的最大补偿量计算安全裁剪区域。
- 在线调整缩放比例，在抖动大时放大更多。
- 使用相邻帧重建或生成缺失区域，但计算量和伪影风险更高。

裁剪会损失视场，缩放会降低有效清晰度。平滑强度、最大补偿量和裁剪比例需要一起设计，不能独立追求轨迹最平。

### 4.8 全局运动估计失败后的状态重置

场景切换后，上一帧特征与当前帧没有有效对应关系。此时应清空累计轨迹和平滑器状态，在当前帧重新检测特征。若只是一帧运动估计失败，可以暂时使用单位变换或上一可靠运动，并限制连续复用次数。

可用于触发重置的证据包括：有效光流点过少、RANSAC内点数或内点比例过低、估计矩阵为空、平移或旋转突然超过允许范围。失败时继续累计错误矩阵会让后续所有帧发生漂移。

## 5 MeshFlow局部运动估计、PAPS轨迹平滑与网格补偿

MeshFlow是一种只在规则网格顶点保存运动向量的稀疏运动场。它先用全局单应矩阵解释画面的主要运动，再把特征点剩余的局部运动传播到附近网格顶点，经过两次中值滤波得到当前帧的MeshFlow。随后，同一顶点在连续帧中的累计运动形成vertex profile，PAPS沿时间平滑每条profile。[MeshFlow论文页面](https://www.microsoft.com/en-us/research/publication/meshflow-minimum-latency-online-video-stabilization/)

理解这部分时先抓住下面这条主线。MeshFlow没有直接对LK光流得到的特征点位移取中位数：

1. LK光流先得到每个特征点从前一帧到当前帧的实际位置变化。
2. RANSAC筛选整张图的特征点对，并用内点拟合全局单应矩阵。可以把它理解为：从多数特征点的变化中提取一条统一的整幅画面变换规律。
3. 将前一帧特征点坐标乘以单应矩阵，得到该特征点按照全局运动应该到达的位置。
4. 用光流跟踪得到的实际位置减去全局预测位置，得到这个特征点没有被全局模型解释的局部差值。
5. 一个网格点收集附近特征点的局部差值，并分别对横向、纵向分量取中位数。
6. 将网格点自己的坐标乘以同一个单应矩阵，得到这个网格点在全局运动下应该到达的位置，再加上附近局部差值的中位数，得到网格点最终位置。
7. 网格点附近没有特征点时，局部差值取零，直接使用单应矩阵给出的全局预测位置作为辅助结果。

因此，整个计算关系为：

$$
\boxed{
\text{网格点最终位置}
=\text{单应矩阵预测的网格点位置}
+\text{附近特征点局部位置差的中位数}
}
$$

若使用位移表示，同一关系写成：

$$
\boxed{
\text{网格点最终位移}
=\text{网格点全局预测位移}
+\text{附近特征点局部残差位移的中位数}
}
$$

### 5.1 全局预变换与特征点局部残差运动

设前一帧特征点为 \(p_k=(x_k,y_k)^T\)，当前帧对应点为 \(q_k\)。RANSAC根据全部匹配点估计全局单应矩阵 \(H_t\)。把二维点写成齐次坐标 \(\tilde p_k=(x_k,y_k,1)^T\) 后，全局模型预测的当前帧位置为：

$$
\hat q_k=\pi(H_t\tilde p_k)
$$

\(\pi([a,b,c]^T)=(a/c,b/c)^T\)负责把齐次坐标还原成二维坐标。实际跟踪位置与全局模型预测位置之间的差就是局部残差运动：

$$
r_k=q_k-\hat q_k
$$

对网格顶点 \(g_i\)，全局单应矩阵产生的顶点运动为：

$$
h_{i,t}=\pi(H_t\tilde g_i)-g_i
$$

因此，MeshFlow把每个顶点运动分为“全局运动 \(h_{i,t}\)”和“附近特征点提供的局部残差”。全局预变换可以在低纹理顶点没有候选残差时仍提供基础运动。

代码中通常先用`findHomography()`求 \(H_t\)，再对每个特征点和网格顶点执行透视除法：

```cpp
// H把前一帧坐标映射到当前帧。输入和返回值都使用像素坐标。
static cv::Point2f transformPoint(const cv::Mat& H,
                                  const cv::Point2f& point) {
    const double a = H.at<double>(0, 0) * point.x
                   + H.at<double>(0, 1) * point.y
                   + H.at<double>(0, 2);
    const double b = H.at<double>(1, 0) * point.x
                   + H.at<double>(1, 1) * point.y
                   + H.at<double>(1, 2);
    const double c = H.at<double>(2, 0) * point.x
                   + H.at<double>(2, 1) * point.y
                   + H.at<double>(2, 2);
    return {static_cast<float>(a / c), static_cast<float>(b / c)};
}

const cv::Point2f predicted = transformPoint(H, previous_point);
const cv::Point2f residual = current_point - predicted;
```

### 5.2 将局部残差运动传播到附近网格顶点

对每个顶点 \(g_i\)，收集距离它不超过传播半径 \(R\) 的特征点残差：

$$
\mathcal R_i=\{r_k\mid \|p_k-g_i\|_2<R\}
$$

这一步没有求解方程。程序只是在建立“顶点编号到候选残差数组”的映射。论文使用覆盖特征点附近区域的传播范围；具体实现可以按圆形半径或固定的若干网格单元查找顶点。

直接遍历全部“顶点—特征点”组合容易产生 \(O(N_vN_f)\) 次距离计算。工程代码通常根据特征点坐标先算出它所在的网格行列，再只遍历传播范围内的顶点：

```cpp
// candidates[vertex_index]保存这个顶点收到的全部局部残差。
std::vector<std::vector<cv::Point2f>> candidates(vertex_count);

for (std::size_t k = 0; k < previous_points.size(); ++k) {
    const cv::Point2f predicted = transformPoint(H, previous_points[k]);
    const cv::Point2f residual = current_points[k] - predicted;

    // row_begin等边界由特征点坐标、网格间距和传播半径计算，并裁到网格范围内。
    for (int row = row_begin; row <= row_end; ++row) {
        for (int col = col_begin; col <= col_end; ++col) {
            const int vertex_index = row * grid_cols + col;
            if (cv::norm(vertices[vertex_index] - previous_points[k]) < radius) {
                candidates[vertex_index].push_back(residual);
            }
        }
    }
}
```

### 5.3 第一次中值滤波确定每个顶点的运动

顶点 \(i\) 收到 \(n_i\) 个候选残差后，分别取横向和纵向分量的中位数：

$$
\bar r_{i,t}=
\begin{bmatrix}
\operatorname{median}(r_{1x},r_{2x},\ldots,r_{n_ix})\\
\operatorname{median}(r_{1y},r_{2y},\ldots,r_{n_iy})
\end{bmatrix}
$$

将它加到5.1节的全局顶点运动上，得到第一次滤波后的顶点运动：

$$
m^{(1)}_{i,t}=h_{i,t}+\bar r_{i,t}
$$

一个极大的错误残差只会落在排序后的一端，通常不会改变中间值。若 \(\mathcal R_i\) 为空，则令 \(\bar r_{i,t}=0\)，该顶点只使用全局运动 \(h_{i,t}\)。

中值没有普通矩阵乘法形式，它需要排序、`nth_element()`或专用中值滤波函数。顶点候选数为奇数时取排序后的中间元素；为偶数时可以取中间两个数的平均值，整个程序必须统一这一约定。

```cpp
// nth_element只保证中间位置是排序后应有的元素，避免完整排序。
static float median(std::vector<float> values) {
    if (values.empty()) {
        return 0.0F;
    }
    const std::size_t middle = values.size() / 2;
    std::nth_element(values.begin(), values.begin() + middle, values.end());
    const float upper = values[middle];
    if (values.size() % 2 == 1) {
        return upper;
    }
    std::nth_element(values.begin(), values.begin() + middle - 1,
                     values.begin() + middle);
    return 0.5F * (values[middle - 1] + upper);
}
```

### 5.4 第二次空间中值滤波生成MeshFlow

第一次滤波仍可能留下由错误匹配或动态物体产生的孤立顶点运动。第二次滤波在网格的 \(3\times3\) 顶点邻域中再次分别取横纵分量中位数：

$$
m_{i,t}=
\begin{bmatrix}
\operatorname{median}_{j\in\mathcal N_i}(m^{(1)}_{j,t,x})\\
\operatorname{median}_{j\in\mathcal N_i}(m^{(1)}_{j,t,y})
\end{bmatrix}
$$

\(\mathcal N_i\)包含顶点自身以及最多八个邻居。输出 \(m_{i,t}\) 就是第 \(t-1\) 帧到第 \(t\) 帧的MeshFlow。论文将“两次中值滤波产生每个顶点的唯一运动”作为MeshFlow运动传播的核心步骤；配套实现也对横纵运动矩阵执行二维`3×3`中值滤波。[论文配套实现中的运动传播](https://github.com/sudheerachary/Mesh-Flow-Video-Stabilization/blob/master/src/MeshFlow.py)

代码可以直接写两层网格循环，将邻域最多九个值交给5.3节的`median()`。网格行列数较小，这部分通常不需要线性代数库。

### 5.5 累计MeshFlow生成每个顶点的vertex profile

\(m_{i,t}\)只表示相邻两帧之间的运动。同一个固定网格顶点沿时间累计后得到原始轨迹：

$$
C_{i,0}=0,\qquad C_{i,t}=C_{i,t-1}+m_{i,t}
$$

对一个网格顶点，\(C_{i,0},C_{i,1},\ldots,C_{i,T-1}\)构成一条vertex profile。横坐标和纵坐标分别保存成长度为 \(T\) 的数组。代码中常用三维数组`profile[grid_row][grid_col][frame]`，当前帧只需把上一项与当前MeshFlow相加：

```cpp
x_profile(row, col, t) = x_profile(row, col, t - 1) + mesh_x(row, col);
y_profile(row, col, t) = y_profile(row, col, t - 1) + mesh_y(row, col);
```

### 5.6 PAPS目标函数中每一部分的作用

预测自适应路径平滑（Predicted Adaptive Path Smoothing，PAPS）对每个顶点的横向和纵向profile分别求解。为简化符号，下面只写一条一维轨迹：原始轨迹为 \(C_t\)，待求平滑轨迹为 \(P_t\)。其基本二次目标为：

$$
E(P)=\sum_{t=0}^{T-1}(P_t-C_t)^2
+\sum_{t=0}^{T-1}\lambda_t
\sum_{r\in\Omega_t}w_{tr}(P_t-P_r)^2
$$

其中高斯时间权重为：

$$
w_{tr}=\exp\left[-\frac{(t-r)^2}{(\Omega/3)^2}\right]
=\exp\left[-\frac{9(t-r)^2}{\Omega^2}\right]
$$

各部分含义如下：

- \((P_t-C_t)^2\)让平滑位置靠近原始位置。它限制补偿幅度、裁剪量和画面拉伸。
- \((P_t-P_r)^2\)让时间上相邻的平滑位置接近，用来压制快速抖动。
- \(w_{tr}\)让距离当前帧越近的轨迹点影响越大；超出窗口 \(\Omega_t\) 的点权重为零。
- \(\lambda_t\)控制第 \(t\) 帧的平滑强度。PAPS根据当前运动预测该权重：缓慢运动可以使用较强平滑，快速主动运镜需要降低平滑强度。
- 在线PAPS的 \(\Omega_t\)只包含当前帧和过去帧，因此不需要未来图像。

MeshFlow论文给出了根据全局运动中的平移速度和仿射形变预测 \(\lambda_t\) 的经验模型。该预测式的系数来自论文实验拟合，移植到不同分辨率、帧率和相机时需要重新验证；配套开源实现使用固定`lambda_t = 100`演示同一个优化目标。[论文配套实现中的轨迹优化](https://github.com/sudheerachary/Mesh-Flow-Video-Stabilization/blob/master/src/Optimization.py)

### 5.7 将PAPS目标函数变成矩阵方程并求解

先把一条长度为 \(T\) 的profile写成列向量：

$$
P=[P_0,P_1,\ldots,P_{T-1}]^T,\qquad
C=[C_0,C_1,\ldots,C_{T-1}]^T
$$

然后为目标函数中的每一对 \((t,r)\)建立一行差分。设这条边的系数为 \(a_{tr}=\lambda_tw_{tr}\)，对应的差分矩阵 \(D\) 在该行只有两个非零元素：

$$
D_{e,t}=\sqrt{a_{tr}},\qquad
D_{e,r}=-\sqrt{a_{tr}}
$$

因此这一行满足：

$$
(DP)_e=\sqrt{a_{tr}}(P_t-P_r)
$$

把窗口中的所有时间点对都写入 \(D\)，目标函数变成：

$$
E(P)=\|P-C\|_2^2+\|DP\|_2^2
$$

展开并对 \(P\)求导：

$$
\frac{\partial E}{\partial P}
=2(P-C)+2D^TDP=0
$$

整理后得到线性方程组：

$$
(I+D^TD)P=C
$$

矩阵各部分来自明确的数据：

- \(I\)是 \(T\times T\)单位矩阵，来自数据项 \(\|P-C\|^2\)。
- \(D\)的行数等于时间窗口内建立的点对数量，列数为 \(T\)。
- \(D^TD\)来自所有高斯加权的轨迹差，它是稀疏、对称、半正定矩阵。
- \(C\)直接由5.5节累计的vertex profile填入。
- 解出的 \(P\)就是这个顶点某一个坐标方向的全部平滑位置。

程序不计算 \((I+D^TD)^{-1}\)。离线实现使用稀疏Cholesky或共轭梯度法直接求 \(AP=C\)，其中 \(A=I+D^TD\)。同一个时间权重矩阵可供所有顶点和横纵方向复用；若每一帧的 \(\lambda_t\)也相同，矩阵分解只需执行一次。

使用Eigen稀疏矩阵库时，核心结构如下：

```cpp
// triplets保存D中的非零元素。每个时间点对只写入+t和-r两项。
std::vector<Eigen::Triplet<double>> triplets;
int edge_row = 0;
for (int t = 0; t < frame_count; ++t) {
    for (int r = std::max(0, t - window_radius); r < t; ++r) {
        const double weight = std::exp(
            -9.0 * (t - r) * (t - r) /
            static_cast<double>(window_size * window_size));
        const double scale = std::sqrt(lambda[t] * weight);
        triplets.emplace_back(edge_row, t, scale);
        triplets.emplace_back(edge_row, r, -scale);
        ++edge_row;
    }
}

Eigen::SparseMatrix<double> D(edge_row, frame_count);
D.setFromTriplets(triplets.begin(), triplets.end());

Eigen::SparseMatrix<double> A(frame_count, frame_count);
A.setIdentity();
A += D.transpose() * D;

// 对A分解一次。每个顶点的x/y原始profile分别作为右端C求解。
Eigen::SimplicialLDLT<Eigen::SparseMatrix<double>> solver;
solver.compute(A);
Eigen::VectorXd smooth_profile = solver.solve(original_profile);
```

在线实现只保留长度为 \(B\) 的历史窗口。论文配套示例把 \(\lambda\)设为固定值，并使用对称高斯权重 \(w_{tr}=w_{rt}\)。此时对第 \(t\) 个未知量求偏导，可以得到固定点更新：

$$
P_t^{(k+1)}=
\frac{C_t+\lambda\sum_{r\in\Omega_t}w_{tr}P_r^{(k)}}
{1+\lambda\sum_{r\in\Omega_t}w_{tr}}
$$

代码先构造高斯权重矩阵 \(W\)，计算每一行的权重和，再重复执行“矩阵乘法求邻居加权和—逐元素除以总系数”：

```cpp
// C和P都是长度为B的一条顶点坐标轨迹，W是B×B对称高斯权重矩阵。
const Eigen::VectorXd denominator =
    Eigen::VectorXd::Ones(buffer_size)
    + lambda_value * W * Eigen::VectorXd::Ones(buffer_size);

Eigen::VectorXd P = C;
for (int iteration = 0; iteration < 10; ++iteration) {
    P = (C + lambda_value * W * P).cwiseQuotient(denominator);
}
```

这种写法适合短滑动窗口。若PAPS为每一帧预测不同的 \(\lambda_t\)，或者时间邻接关系不对称，应按前面构造 \(D\) 的方法把实际权重全部写进矩阵，再求 \((I+D^TD)P=C\)，这样不会漏掉一个未知量在其他时间项中受到的约束。[配套实现的固定点更新](https://github.com/sudheerachary/Mesh-Flow-Video-Stabilization/blob/master/src/Optimization.py)

### 5.8 从平滑vertex profile生成网格补偿并变形图像

顶点 \(i\) 在第 \(t\) 帧的补偿位移为平滑轨迹减去原始轨迹：

$$
d_{i,t}=P_{i,t}-C_{i,t}
$$

对一个网格单元内的像素 \(p\)，使用四个角点补偿位移进行双线性插值：

$$
d_t(p)=\sum_{r=1}^{4}b_r(p)d_{i_r,t}
$$

若像素在单元内的归一化坐标为 \((\xi,\eta)\)，四个权重依次为：

$$
(1-\xi)(1-\eta),\quad
\xi(1-\eta),\quad
(1-\xi)\eta,\quad
\xi\eta
$$

OpenCV的`remap()`需要为每个输出像素提供输入采样位置。若 \(d_t\)定义为输入位置到输出位置的前向补偿，则反向采样坐标为：

$$
p_{src}=p_{out}-d_t(p_{out})
$$

程序将 \(p_{src}\) 的横纵坐标分别写入`map_x`和`map_y`，然后调用`remap()`。另一种实现会为每个网格单元的四个角点求局部单应矩阵，再用它生成该单元的采样坐标；论文配套代码采用了这一方式。[配套实现中的网格变形](https://github.com/sudheerachary/Mesh-Flow-Video-Stabilization/blob/master/src/MeshFlow.py)

## 6 OpenCV稀疏光流全局电子稳像Demo

### 6.1 Demo输入、依赖与输出

这个Demo使用C++17和OpenCV 4.x处理一个本地视频，输出左右对比视频：左侧为原始画面，右侧为稳定画面。它采用相似变换、前后向检查、RANSAC和居中移动平均，属于离线全局稳像。

需要的OpenCV模块为`core、imgproc、video、calib3d、videoio`。输入视频使用普通MP4或摄像头录制的短视频，画面最好包含足够背景纹理。

### 6.2 Shi–Tomasi特征检测与LK光流跟踪

程序每帧重新检测Shi–Tomasi角点，避免长期跟踪后点逐渐集中或丢失。随后执行正向和反向LK光流，并使用1.5像素的前后向误差过滤点。

### 6.3 前后向检查与RANSAC全局运动估计

通过光流检查的点交给`estimateAffinePartial2D()`。Demo至少要求12个有效点和8个RANSAC内点；条件不满足时使用单位运动，防止不可靠矩阵进入轨迹。

### 6.4 全局轨迹累计、移动平均与补偿矩阵

为了使用居中移动平均，程序先读取全部帧并估计相邻运动，再统一计算累计轨迹和平滑轨迹。平滑半径默认为15帧，30 fps视频会观察前后各约0.5秒。

### 6.5 视频变换、裁剪与输出

下面是完整程序。它固定裁掉每边5%的画面，再缩放到原尺寸，以隐藏常见的小幅补偿黑边。大幅抖动仍可能露出边界，此时需要增加裁剪比例或限制补偿量。

```cpp
#include <opencv2/calib3d.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/video/tracking.hpp>
#include <opencv2/videoio.hpp>

#include <algorithm>
#include <cmath>
#include <iostream>
#include <string>
#include <vector>

// 保存一帧相对于前一帧的相似运动参数。
// dx、dy的单位是原图像素，da的单位是弧度。
struct Motion {
    double dx = 0.0;
    double dy = 0.0;
    double da = 0.0;
};

// 保存从视频开始累计到当前帧的全局轨迹。
struct Trajectory {
    double x = 0.0;
    double y = 0.0;
    double a = 0.0;
};

// 计算两个二维点之间的欧氏距离，单位为像素。
static double pointDistance(const cv::Point2f& first,
                            const cv::Point2f& second) {
    const double dx = static_cast<double>(first.x - second.x);
    const double dy = static_cast<double>(first.y - second.y);
    return std::sqrt(dx * dx + dy * dy);
}

// 根据相邻两帧估计一组全局相似运动参数。
// 成功时返回RANSAC支持的平移和旋转；证据不足时返回零运动，
// 调用方仍可继续处理视频，但不会把这一帧的不可靠结果累计到轨迹中。
static Motion estimateMotion(const cv::Mat& previous_bgr,
                             const cv::Mat& current_bgr) {
    cv::Mat previous_gray;
    cv::Mat current_gray;
    cv::cvtColor(previous_bgr, previous_gray, cv::COLOR_BGR2GRAY);
    cv::cvtColor(current_bgr, current_gray, cv::COLOR_BGR2GRAY);

    std::vector<cv::Point2f> previous_points;
    cv::goodFeaturesToTrack(
        previous_gray,
        previous_points,
        300,   // 最多保留300个角点，限制每帧计算量。
        0.01,  // 角点质量至少达到最佳角点响应的1%。
        20.0); // 任意两个角点至少相距20像素，避免点挤在一个区域。

    if (previous_points.size() < 12) {
        return {};
    }

    std::vector<cv::Point2f> current_points;
    std::vector<unsigned char> forward_status;
    std::vector<float> forward_error;
    cv::calcOpticalFlowPyrLK(
        previous_gray, current_gray,
        previous_points, current_points,
        forward_status, forward_error,
        cv::Size(21, 21), 3);

    // 将正向跟踪结果再跟踪回前一帧。索引i始终对应同一个原始角点。
    std::vector<cv::Point2f> backward_points;
    std::vector<unsigned char> backward_status;
    std::vector<float> backward_error;
    cv::calcOpticalFlowPyrLK(
        current_gray, previous_gray,
        current_points, backward_points,
        backward_status, backward_error,
        cv::Size(21, 21), 3);

    std::vector<cv::Point2f> valid_previous;
    std::vector<cv::Point2f> valid_current;
    for (std::size_t i = 0; i < previous_points.size(); ++i) {
        // 任一方向跟踪失败，或者返回原点的误差超过1.5像素，
        // 该点不会进入全局运动估计。
        if (forward_status[i] == 0 || backward_status[i] == 0) {
            continue;
        }
        if (pointDistance(previous_points[i], backward_points[i]) > 1.5) {
            continue;
        }
        valid_previous.push_back(previous_points[i]);
        valid_current.push_back(current_points[i]);
    }

    if (valid_previous.size() < 12) {
        return {};
    }

    cv::Mat inlier_mask;
    const cv::Mat transform = cv::estimateAffinePartial2D(
        valid_previous,
        valid_current,
        inlier_mask,
        cv::RANSAC,
        3.0,   // RANSAC重投影阈值，单位为原图像素。
        2000,  // 最多随机采样次数。
        0.99); // 期望找到有效模型的置信度。

    if (transform.empty()) {
        return {};
    }

    const int inlier_count = cv::countNonZero(inlier_mask);
    if (inlier_count < 8) {
        return {};
    }

    // 相似变换左上2×2部分近似为：
    // [ cos(a)*s  -sin(a)*s ]
    // [ sin(a)*s   cos(a)*s ]
    // atan2(m10, m00)可同时消去等比例缩放s并取得旋转角。
    Motion motion;
    motion.dx = transform.at<double>(0, 2);
    motion.dy = transform.at<double>(1, 2);
    motion.da = std::atan2(transform.at<double>(1, 0),
                           transform.at<double>(0, 0));
    return motion;
}

// 对累计轨迹执行居中移动平均。
// 输出与输入长度一致；序列两端只平均实际存在的帧。
static std::vector<Trajectory> smoothTrajectory(
    const std::vector<Trajectory>& trajectory,
    int radius) {
    std::vector<Trajectory> smoothed(trajectory.size());

    for (std::size_t i = 0; i < trajectory.size(); ++i) {
        const int center = static_cast<int>(i);
        const int begin = std::max(0, center - radius);
        const int end = std::min(static_cast<int>(trajectory.size()) - 1,
                                 center + radius);

        Trajectory sum;
        for (int j = begin; j <= end; ++j) {
            sum.x += trajectory[j].x;
            sum.y += trajectory[j].y;
            sum.a += trajectory[j].a;
        }

        const double count = static_cast<double>(end - begin + 1);
        smoothed[i] = {sum.x / count, sum.y / count, sum.a / count};
    }
    return smoothed;
}

// 根据补偿后的相邻运动生成OpenCV使用的2×3仿射矩阵。
static cv::Mat makeTransform(const Motion& motion) {
    const double cosine = std::cos(motion.da);
    const double sine = std::sin(motion.da);
    return (cv::Mat_<double>(2, 3) <<
        cosine, -sine, motion.dx,
        sine,    cosine, motion.dy);
}

// 固定裁掉四周crop_ratio比例，再缩放回原尺寸。
// 输入帧未被修改；返回值拥有独立的输出图像数据。
static cv::Mat cropAndResize(const cv::Mat& frame, double crop_ratio) {
    const int crop_x = static_cast<int>(frame.cols * crop_ratio);
    const int crop_y = static_cast<int>(frame.rows * crop_ratio);
    const cv::Rect safe_region(
        crop_x,
        crop_y,
        frame.cols - 2 * crop_x,
        frame.rows - 2 * crop_y);

    cv::Mat output;
    cv::resize(frame(safe_region), output, frame.size(),
               0.0, 0.0, cv::INTER_LINEAR);
    return output;
}

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "用法: " << argv[0]
                  << " input.mp4 output_compare.mp4\n";
        return 1;
    }

    const std::string input_path = argv[1];
    const std::string output_path = argv[2];

    cv::VideoCapture capture(input_path);
    if (!capture.isOpened()) {
        std::cerr << "无法打开输入视频: " << input_path << '\n';
        return 1;
    }

    const double fps = capture.get(cv::CAP_PROP_FPS);
    if (fps <= 0.0) {
        std::cerr << "输入视频没有有效帧率信息\n";
        return 1;
    }

    // Demo是离线处理，因此把帧保存在内存中。
    // 长视频应改成临时文件或分段处理，避免内存随帧数持续增长。
    std::vector<cv::Mat> frames;
    cv::Mat frame;
    while (capture.read(frame)) {
        frames.push_back(frame.clone());
    }

    if (frames.size() < 2) {
        std::cerr << "输入视频至少需要两帧\n";
        return 1;
    }

    std::vector<Motion> motions;
    motions.reserve(frames.size() - 1);
    for (std::size_t i = 1; i < frames.size(); ++i) {
        motions.push_back(estimateMotion(frames[i - 1], frames[i]));
    }

    // trajectory[i]对应motions[i]执行完后的累计位置，也就是原视频第i+1帧。
    std::vector<Trajectory> trajectory;
    trajectory.reserve(motions.size());
    Trajectory accumulated;
    for (const Motion& motion : motions) {
        accumulated.x += motion.dx;
        accumulated.y += motion.dy;
        accumulated.a += motion.da;
        trajectory.push_back(accumulated);
    }

    const int smoothing_radius = 15;
    const std::vector<Trajectory> smoothed =
        smoothTrajectory(trajectory, smoothing_radius);

    // 把“平滑轨迹与原轨迹之差”加到每个相邻运动上，
    // 得到真正送给warpAffine()的补偿后运动。
    std::vector<Motion> stabilized_motions(motions.size());
    for (std::size_t i = 0; i < motions.size(); ++i) {
        stabilized_motions[i].dx =
            motions[i].dx + smoothed[i].x - trajectory[i].x;
        stabilized_motions[i].dy =
            motions[i].dy + smoothed[i].y - trajectory[i].y;
        stabilized_motions[i].da =
            motions[i].da + smoothed[i].a - trajectory[i].a;
    }

    const cv::Size single_size = frames.front().size();
    const cv::Size compare_size(single_size.width * 2, single_size.height);
    cv::VideoWriter writer(
        output_path,
        cv::VideoWriter::fourcc('m', 'p', '4', 'v'),
        fps,
        compare_size);
    if (!writer.isOpened()) {
        std::cerr << "无法创建输出视频: " << output_path << '\n';
        return 1;
    }

    // 第一帧没有前序运动，左右两侧都直接使用原帧。
    cv::Mat first_compare;
    cv::hconcat(frames.front(), frames.front(), first_compare);
    writer.write(first_compare);

    for (std::size_t i = 1; i < frames.size(); ++i) {
        cv::Mat stabilized;
        cv::warpAffine(
            frames[i],
            stabilized,
            makeTransform(stabilized_motions[i - 1]),
            single_size,
            cv::INTER_LINEAR,
            cv::BORDER_CONSTANT,
            cv::Scalar(0, 0, 0));

        stabilized = cropAndResize(stabilized, 0.05);

        cv::Mat comparison;
        cv::hconcat(frames[i], stabilized, comparison);
        writer.write(comparison);

        std::cout << "frame=" << i
                  << " raw_dx=" << motions[i - 1].dx
                  << " raw_dy=" << motions[i - 1].dy
                  << " raw_da=" << motions[i - 1].da
                  << " corrected_dx=" << stabilized_motions[i - 1].dx
                  << " corrected_dy=" << stabilized_motions[i - 1].dy
                  << " corrected_da=" << stabilized_motions[i - 1].da
                  << '\n';
    }

    std::cout << "已输出左右对比视频: " << output_path << '\n';
    return 0;
}
```

Linux下可以直接编译运行：

```bash
g++ -std=c++17 -O2 stabilize.cpp -o stabilize \
    $(pkg-config --cflags --libs opencv4)
./stabilize input.mp4 output_compare.mp4
```

Windows使用Visual Studio时，需要把OpenCV的头文件目录、库目录和对应版本的OpenCV库加入工程，并把OpenCV DLL放入可执行文件可搜索的位置。源码本身不依赖Linux专用接口。

### 6.6 光流点、运动曲线与稳像结果检查

程序执行顺序为：读取全部帧、估计每对相邻帧运动、累计轨迹、居中平滑轨迹、计算补偿运动、逐帧变换并写出左右对比视频。控制台中的`raw_dx/raw_dy/raw_da`是估计出的原始相邻运动，`corrected_*`是加入轨迹修正后的变换。

如果输出仍明显抖动，先把通过前后向检查的光流点和RANSAC内点画到图上，检查点是否覆盖静态背景；随后绘制原始与平滑后的`x、y、a`曲线。光流点本身错误，应调整角点、窗口、金字塔和检查阈值；点正确但矩阵跳变，应检查动态物体、RANSAC内点和运动模型；轨迹已经平滑但画面变形，应检查补偿矩阵方向、变换顺序和裁剪范围。
