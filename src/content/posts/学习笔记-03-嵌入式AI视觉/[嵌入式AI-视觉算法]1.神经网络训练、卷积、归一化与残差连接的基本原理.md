---
title: '[嵌入式AI-视觉算法] 神经网络训练、卷积、归一化与残差连接的基本原理'
published: 2026-09-24T08:21:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍神经网络训练、卷积、归一化与残差连接的基本原理的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '计算机视觉', '深度学习']
category: '嵌入式AI-视觉算法'
draft: false
lang: zh_CN
---

# 阶段3-1 神经网络训练、卷积、归一化与残差连接的基本原理

神经网络训练要解决的核心问题是：输入张量经过哪些计算得到预测，预测误差怎样转化为每个参数的梯度，优化器又怎样用梯度产生下一轮参数。完整链路如下：

```text
输入张量 → 网络前向传播 → 预测输出 → 损失函数 → 标量损失
                                              ↓
下一轮前向传播 ← 优化器更新参数 ← 参数梯度 ← 反向传播
```

卷积、激活、归一化和残差连接都位于“网络前向传播”内部。本节先建立这些组件共同遵守的数据关系；PyTorch类、函数和完整训练循环的API用法放到阶段3-2。

## 1 张量的shape、dtype、device与NCHW/NHWC布局

张量（Tensor）是带有形状、数据类型和计算设备信息的多维数组。神经网络的层接收张量并返回新张量，因此排查模型错误时，先检查张量契约：每一维表示什么、元素是什么类型、数据位于什么设备。

### 1.1 batch、channel、height和width的维度语义

一批二维图像常用四个维度表示：

- (N)：批量大小（batch size），一次送入网络的样本数；
- (C)：通道数（channel），例如RGB图像有3个颜色通道，中间特征图可以有几十或几百个通道；
- (H)：高度（height）；
- (W)：宽度（width）。

NCHW表示张量shape按 ((N,C,H,W)) 排列。例如`(4, 3, 640, 640)`表示4张三通道、640×640的图像。NHWC按 ((N,H,W,C)) 排列，同一批图像对应`(4, 640, 640, 3)`。

shape只说明各维长度和语义。它不记录RGB还是BGR，也不记录数值是否已经从0～255缩放到0～1。模型输入契约还应同时写明颜色顺序、数值范围和归一化参数；这些信息错了，shape仍然可以完全正确，推理结果却会明显下降。

### 1.2 数据类型、计算设备与张量运算兼容条件

`dtype`（data type，数据类型）决定张量中的元素怎样存储和计算。数据类型限制必须连同“限制哪个对象、由哪个操作检查”一起理解。输入、模型参数、标签和中间张量承担不同职责，不能只记一张孤立的类型表。

常见数据类型包括：

- `float32`：训练和通用推理的常见浮点类型；
- `float16`、`bfloat16`：占用更少存储，可在支持的硬件上加速计算；
- `int8`：量化推理常用整数类型；
- `int64`：PyTorch多分类的类别索引标签常用类型。

这些类型分别约束以下对象：

1. **模型输入**：输入dtype必须是第一层算子支持的类型。普通浮点`Conv2d`训练常接收`float32`输入；若权重是`float32`，手工传入`float64`输入会产生类型不匹配。`uint8`摄像头图像需要先按模型预处理契约转换成浮点数并完成缩放。量化模型是另一套算子契约，它可以接收量化后的整数张量，不能据此把普通浮点模型的输入直接改成`int8`。
2. **权重 (W) 和偏置 (b)**：可训练参数需要使用支持求导的浮点或复数类型，不能把需要梯度下降更新的权重保存成普通整数张量。一次卷积或矩阵乘法还要求输入与权重满足该内核的类型组合；未启用混合精度机制时，最清楚的做法是让输入与参数使用相同浮点类型。偏置参与同一个算子，也必须满足该算子的dtype和device约束。
3. **标签**：标签类型由损失函数决定，不由模型输入类型决定。`CrossEntropyLoss`使用类别索引时，标签是`int64`/`long`；`BCEWithLogitsLoss`、MSE和L1的标签要用浮点数，并与预测具有可对应的shape。第4节会逐个说明这些输入契约。
4. **中间张量**：某层输出会成为下一层输入。中间激活一般沿用当前计算产生的dtype和device；在前向函数里临时创建一个默认CPU常量，再与GPU激活相加，也会触发设备不一致。

`device`表示张量所在的计算设备，例如CPU或编号为0的CUDA GPU。约束发生在一次具体运算的参与者之间：执行卷积时检查输入、权重和偏置；计算损失时检查预测与标签；执行参数更新时检查参数、梯度和优化器状态。模型参数在GPU而输入在CPU时，第一层就会报告设备不一致。预测在GPU而标签在CPU时，损失函数会在两者第一次共同运算的位置报错。

自动混合精度（Automatic Mixed Precision，AMP）会在受支持算子周围自动选择`float16`、`bfloat16`或`float32`计算，并使用梯度缩放降低低精度下溢风险。AMP提供的是受控的类型转换规则，不能让任意dtype组合自动变得合法。

类型转换和设备迁移都可能产生新的数据或触发真实复制。训练循环应在明确的位置完成转换，避免在每一层内部反复搬运张量。具体的`.to()`、`.float()`等API在阶段3-2讲解。

### 1.3 张量维度顺序、内存步长与连续存储的区别

张量的维度顺序描述逻辑索引，步长（stride）描述某一维索引增加1时，底层存储地址需要跨过多少个元素。PyTorch的`tensor.stride()`以元素个数为单位；阶段2-2中的图像行stride以字节为单位，两者使用前必须先确认单位。

以连续NCHW张量为例，shape为`(1, 3, 4, 5)`时，典型元素步长为`(60, 20, 5, 1)`：宽度索引增加1跨过1个元素，高度索引增加1跨过5个元素，通道索引增加1跨过20个元素。

`permute()`可以只改变维度解释和步长，不立即复制数据。因此，把NCHW执行`permute(0, 2, 3, 1)`后会得到NHWC的shape，但该视图不保证采用紧密NHWC物理排列。下游算子若要求连续输入，需要读取张量实际的stride或连续性状态，再决定是否调用`contiguous()`产生新副本。图像缓冲区的字节stride、padding和ROI地址关系已在阶段2-2第1、3节解释，这里只保留张量维度对应关系。

## 2 前向传播、计算图、反向传播与梯度

训练中的一次迭代由三个不同动作组成：网络计算预测，自动微分计算梯度，优化器修改参数。把这三个动作分开理解，才能解释“有损失但参数没变化”“梯度越来越大”和“恢复训练后轨迹改变”等问题。

### 2.1 前向传播与计算图保存的运算关系

前向传播（forward propagation）按照网络定义从输入计算输出。假设一个标量模型为：

\[
z=wx+b,\qquad \hat{y}=z^2
\]

输入是 (x)，可训练参数是 (w,b)，预测是 \(\hat{y}\)。启用自动微分时，PyTorch会在执行运算的同时建立计算图。图中的节点记录运算之间的依赖关系；反向公式需要某个前向值时，自动微分系统还会保存该值。

计算图由本次实际执行的张量运算动态建立。一次反向传播结束后，默认会释放仅供该图使用的中间结果。保留计算图会增加内存占用，只应在同一图确实需要多次反向传播时使用。

### 2.2 链式法则与参数梯度的计算过程

梯度表示损失对参数的偏导数。若损失为

\[
L=(\hat{y}-y)^2,
\]

则反向传播从 (L) 开始，沿计算图反向应用链式法则：

\[
\frac{\partial L}{\partial w}
=\frac{\partial L}{\partial \hat{y}}
\frac{\partial \hat{y}}{\partial z}
\frac{\partial z}{\partial w}.
\]

代入各局部导数可得：

\[
\frac{\partial L}{\partial w}
=2(\hat{y}-y)\cdot 2z\cdot x.
\]

自动微分的工作重点就是：前向时保存依赖关系和必要中间值，反向时接收下游梯度、计算当前运算的局部梯度，再把结果传给上游。参数最终得到的梯度是所有通向损失的路径贡献之和。

梯度正负只表示局部变化方向。梯度为正时，参数增大会使损失在当前位置增大；优化器通常让参数向负梯度方向移动。梯度数值很大可能导致更新过猛，接近零则可能导致学习缓慢，还需结合学习率判断实际参数改变量。

### 2.3 梯度计算、梯度累加与参数更新的执行顺序

PyTorch把新计算出的梯度累加到参数现有的`.grad`中。连续执行两次反向传播且没有清理旧梯度，第二次看到的是两次贡献之和。这个设计支持梯度累积训练，也意味着普通训练循环必须主动清理上一轮梯度。

一轮训练的因果顺序为：

1. 清理上一轮保存在参数上的梯度；
2. 用当前参数执行前向传播；
3. 根据预测和标签计算标量损失；
4. 从损失执行反向传播，把梯度累加到参数；
5. 优化器读取参数梯度和历史状态，更新参数；
6. 下一轮前向传播读取更新后的参数。

清理梯度不会修改参数，反向传播也不会自动修改参数。执行了前向和反向但漏掉优化器更新时，损失可正常显示，模型权重仍保持原值。

## 3 梯度下降、动量、Adam与AdamW的参数更新机制

优化器接收本轮梯度，结合学习率和历史状态计算参数改变量。下面只解释更新关系；PyTorch优化器对象、参数组和状态保存接口放到阶段3-2。

### 3.1 梯度下降与学习率

设第 (t) 轮更新前参数为 \(\theta_{t-1}\)，本轮梯度为 \(g_t\)，学习率为 \(\eta\)，最基本的梯度下降更新是：

\[
\theta_t=\theta_{t-1}-\eta g_t.
\]

学习率直接缩放本轮参数改变量。例如 \(\theta=2\)、\(g=0.5\)、\(\eta=0.1\)，更新后 \(\theta=1.95\)。同一梯度配合 \(\eta=1\) 会得到 \(\theta=1.5\)，移动距离扩大到原来的10倍。

学习率过大时，参数会跨过低损失区域，损失表现为震荡、突然升高或出现非有限数值；学习率过小时，训练损失长时间只发生微小变化。判断学习率应同时观察损失曲线、梯度尺度和参数实际更新量。

### 3.2 动量与优化器历史状态

随机梯度下降（Stochastic Gradient Descent，SGD）使用小批量样本估计梯度。不同批次给出的方向会有波动，动量用一个状态量累计历史方向：

\[
v_t=\mu v_{t-1}+g_t,
\qquad
\theta_t=\theta_{t-1}-\eta v_t.
\]

其中 \(v_t\) 是动量缓冲，\(\mu\) 是动量系数。连续同向的梯度会在缓冲中积累；频繁反向的分量会互相抵消一部分。这里的历史状态属于优化器，不保存在模型参数本身。

保存训练检查点时只保存模型权重，可以恢复推理；要继续原训练轨迹，还需要保存优化器状态和学习率调度状态。遗漏动量缓冲后，恢复训练的第一轮会从空历史状态重新开始。

### 3.3 Adam的自适应更新与AdamW的解耦权重衰减

Adam（Adaptive Moment Estimation，自适应矩估计）为每个参数维护梯度的一阶矩和平方梯度的二阶矩：

\[
m_t=\beta_1m_{t-1}+(1-\beta_1)g_t,
\]

\[
v_t=\beta_2v_{t-1}+(1-\beta_2)g_t^2.
\]

对初始偏差修正后，参数更新为：

\[
\theta_t=\theta_{t-1}
-\eta\frac{\hat{m}_t}{\sqrt{\hat{v}_t}+\epsilon}.
\]

一阶矩提供平滑后的方向，二阶矩按近期梯度平方调整每个参数的更新尺度，\(\epsilon\) 防止分母接近零。Adam的检查点因此需要保存步数、\(m_t\) 和 \(v_t\)。

AdamW中的W表示weight decay（权重衰减）。它把参数收缩与Adam的矩估计分开。设权重衰减系数为 \(\lambda\)，一次收缩可写成：

\[
\theta\leftarrow(1-\eta\lambda)\theta,
\]

随后再应用Adam产生的自适应更新。这样，权重衰减项不会进入一阶矩和二阶矩。PyTorch当前`AdamW`文档也明确说明权重衰减不累积到动量和方差中：[PyTorch AdamW文档](https://docs.pytorch.org/docs/stable/generated/torch.optim.AdamW.html)。

学习率 \(\eta\) 控制梯度更新和衰减的单步尺度，\(\lambda\) 控制参数收缩强度，\(m_t,v_t\) 保存历史梯度信息。这三个量的职责不能互换。

## 4 常用损失函数的公式、PyTorch API与使用场景

损失函数把模型预测和监督目标映射成优化器要降低的数值。它本身不限定数据来自图像、文本、语音还是传感器；选择依据是预测对象的数学结构：连续数值、互斥类别、相互独立的标签、概率分布，或边界框等任务专用结构。

### 4.1 常用损失函数的分类与选择依据

先根据预测和标签的关系选择损失家族，再核对shape、dtype、数值范围和单位：

| 预测目标 | 常用损失 | 适用问题举例 | 关键输入契约 |
|---|---|---|---|
| 连续数值 | MSE、L1、Smooth L1 | 温度预测、设备剩余寿命、坐标或深度回归 | 预测与标签shape可对应，二者表示相同单位 |
| (C) 个互斥类别 | CrossEntropyLoss | 文本主题、声音类别、图像类别、逐位置类别 | 输入为logits；索引标签为`long` |
| 一个二元结果或多个独立标签 | BCEWithLogitsLoss | 异常检测、多标签分类、逐元素二元判断 | 预测为logits；浮点标签与预测shape相同 |
| 两个概率分布 | KLDivLoss | 知识蒸馏、软标签学习、分布匹配 | 模型输入使用对数概率；目标是概率或对数概率 |
| 大量简单负样本掩盖少量难样本 | Focal Loss | 密集检测、类别极不均衡的二元判断 | 输入为logits；标签与输入shape相同 |
| 离散化边界距离 | DFL | 目标检测边界距离回归 | 输入必须符合具体模型的距离分布定义 |

所有PyTorch损失都要决定怎样聚合逐元素结果。`reduction='none'`保留每个位置的损失，`'sum'`求和，`'mean'`求平均。平均分母由具体API定义；做梯度累积、变长序列掩码或多任务加权时，应先取得未聚合损失或明确有效元素数，避免批量大小和padding数量悄悄改变梯度尺度。

### 4.2 MSELoss、L1Loss与SmoothL1Loss的公式、API和回归场景

设预测和标签对应元素分别为 (x_i,y_i)，总元素数为 (M)。均方误差（Mean Squared Error，MSE）的平均损失为：

\[
L_{MSE}=\frac{1}{M}\sum_{i=1}^{M}(x_i-y_i)^2.
\]

PyTorch入口是`torch.nn.MSELoss(reduction='mean')`。`input`与`target`需要具有可广播的shape，实际训练应优先让二者shape完全一致，避免广播把一个标签重复应用到多个预测位置。误差扩大2倍时，单项损失扩大4倍，因此MSE会强烈惩罚大误差。它适合连续值回归、重建误差以及高斯噪声假设下的估计；少量异常标签会显著拉动训练方向。

L1损失也叫平均绝对误差（Mean Absolute Error，MAE）：

\[
L_{L1}=\frac{1}{M}\sum_{i=1}^{M}|x_i-y_i|.
\]

PyTorch入口是`torch.nn.L1Loss(reduction='mean')`。单项梯度在零点两侧的幅值固定，因此极端误差不会像MSE那样产生随误差线性增大的梯度。它适合需要降低异常值影响的回归和重建任务；零点处不平滑，靠近最优点时的更新方向也更容易在两侧切换。

Smooth L1用二次区间平滑零点，用线性区间限制大误差的影响。令 (e_i=x_i-y_i)：

\[
\ell_i=
\begin{cases}
\dfrac{e_i^2}{2\beta}, & |e_i|<\beta,\\[4pt]
|e_i|-\dfrac{\beta}{2}, & |e_i|\ge\beta.
\end{cases}
\]

PyTorch入口是`torch.nn.SmoothL1Loss(beta=1.0, reduction='mean')`。`beta`给出二次区间边界，单位与预测误差相同；坐标以像素为单位时，`beta=1`表示绝对误差小于1像素进入二次区间，坐标已归一化到0～1时，同一个数值代表完全不同的范围。Smooth L1适合同时需要零点附近平滑梯度和大误差稳健性的回归，边界框坐标回归是常见场景。三种API及当前参数定义见[PyTorch损失函数文档](https://docs.pytorch.org/docs/stable/nn.html#loss-functions)。

### 4.3 CrossEntropyLoss与BCEWithLogitsLoss的公式、API和标签契约

logits是模型输出的未归一化分数，可以为任意实数。Softmax把同一组 (C) 个logits转换成总和为1的互斥类别概率：

\[
p_i=\frac{e^{z_i}}{\sum_{j=1}^{C}e^{z_j}}.
\]

`torch.nn.CrossEntropyLoss()`用于互斥多分类。类别索引模式下，输入是未经过Softmax的logits，shape为 \((N,C)\) 或 \((N,C,d_1,\ldots,d_K)\)；标签shape去掉类别维，dtype为`long`，每个有效索引位于 \([0,C)\)。单样本标签为 (y) 时：

\[
L_{CE}=-\log\frac{e^{z_y}}{\sum_{c=1}^{C}e^{z_c}}.
\]

这个API内部完成数值稳定的`LogSoftmax`与负对数似然计算。把Softmax概率提前作为输入，损失函数会再次把它们当作logits，目标函数随之改变。它可以用于任何互斥分类，包括文本、音频、表格和视觉分类；逐像素多分类只是多出 (H,W) 两个位置维。完整输入约定见[PyTorch CrossEntropyLoss文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.CrossEntropyLoss.html)。

Sigmoid把单个logit转换为独立的正类概率：

\[
p=\sigma(z)=\frac{1}{1+e^{-z}}.
\]

`torch.nn.BCEWithLogitsLoss()`用于二分类和多标签分类。对一个logit (z) 与浮点标签 (y\in[0,1])，二元交叉熵为：

\[
L_{BCE}=-\left[y\log\sigma(z)+(1-y)\log(1-\sigma(z))\right].
\]

API把Sigmoid和交叉熵组合在一起以提高数值稳定性，`input`与`target`必须具有相同shape。一个样本具有 (C) 个相互独立标签时，两者都可使用 \((N,C)\)；二值分割可使用 \((N,1,H,W)\)。`pos_weight`按类别放大正样本项，例如100个正样本、300个负样本时可从`pos_weight=3`开始比较召回率和精确率，但最终值仍要通过验证集选择。具体广播规则见[PyTorch BCEWithLogitsLoss文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.BCEWithLogitsLoss.html)。

### 4.4 KLDivLoss与Focal Loss的公式、API和使用条件

KL散度（Kullback–Leibler Divergence）衡量目标概率分布 \(P\) 与模型概率分布 \(Q\) 的差异。对同一组离散事件，\(P_i\) 和 \(Q_i\) 分别表示事件 \(i\) 在两个分布中的概率，并满足 \(\sum_iP_i=\sum_iQ_i=1\)：

\[
D_{KL}(P\parallel Q)=\sum_i P_i\log\frac{P_i}{Q_i}.
\]

每一项都由目标概率 \(P_i\) 加权。目标分布认为重要的事件会获得更高权重；若模型把这些事件的 \(Q_i\) 估得过小，比例 \(P_i/Q_i\) 增大，惩罚随之增大。\(P_i=0\) 的事件按极限约定贡献0；若 \(P_i>0\) 且 \(Q_i=0\)，该项趋向正无穷，表示模型完全排除了目标分布认为可能发生的事件。

KL散度满足：

\[
D_{KL}(P\parallel Q)\ge 0.
\]

当两个分布在所有事件上的概率都相等时取0。它不满足对称性，交换两个分布后会改变“由谁加权”：

\[
D_{KL}(P\parallel Q)\ne D_{KL}(Q\parallel P).
\]

例如目标分布为 \(P=(0.75,0.25)\)，模型分布为 \(Q=(0.5,0.5)\)。使用自然对数计算：

\[
\begin{aligned}
D_{KL}(P\parallel Q)
&=0.75\log\frac{0.75}{0.5}
+0.25\log\frac{0.25}{0.5}\\
&=0.75\log1.5+0.25\log0.5\\
&\approx0.3041-0.1733\\
&=0.1308\ \text{nat}.
\end{aligned}
\]

第二项可以为负，因为模型给第二个事件分配了高于目标的概率；全部事件求和后的KL散度仍然非负。交换方向可得：

\[
D_{KL}(Q\parallel P)
=0.5\log\frac{0.5}{0.75}
+0.5\log\frac{0.5}{0.25}
\approx0.1438\ \text{nat}.
\]

这个结果说明方向必须由任务含义决定。知识蒸馏中，教师分布承担目标角色，常优化 \(D_{KL}(P_{\text{teacher}}\parallel Q_{\text{student}})\)；交换方向会让学生当前分布决定各事件权重，训练含义随之改变。

KL散度能够作为损失函数，关键来自它与交叉熵的关系。目标分布 \(P\) 的熵为：

\[
H(P)=-\sum_iP_i\log P_i.
\]

目标分布与模型分布之间的交叉熵为：

\[
H(P,Q)=-\sum_iP_i\log Q_i.
\]

展开KL散度可得：

\[
\begin{aligned}
D_{KL}(P\parallel Q)
&=\sum_iP_i\log P_i-\sum_iP_i\log Q_i\\
&=H(P,Q)-H(P).
\end{aligned}
\]

因此：

\[
H(P,Q)=H(P)+D_{KL}(P\parallel Q).
\]

训练过程中目标分布 \(P\) 固定，\(H(P)\) 不依赖模型参数。优化器降低交叉熵 \(H(P,Q)\) 时，也在降低 \(D_{KL}(P\parallel Q)\)。硬分类标签可以看成只有正确类别概率为1的one-hot分布，此时直接使用`CrossEntropyLoss`更简洁；教师模型给出的软标签还包含其他类别之间的相对概率，KL散度可以把整组分布关系传给学生模型。

KL散度在损失函数中主要有两种作用：

1. **分布拟合或知识蒸馏**：目标 \(P\) 来自数据统计、规则或教师模型，模型产生 \(Q\)。损失推动模型在所有事件上的概率接近目标，不只检查最大概率对应的类别。
2. **分布正则化**：模型产生一个需要受约束的分布，例如变分自编码器中的近似后验 \(q(z\mid x)\)。损失加入 \(D_{KL}(q(z\mid x)\parallel p(z))\)，推动它接近预先选择的先验 \(p(z)\)。高斯分布场景经常直接使用解析公式计算该项，不一定调用`KLDivLoss`。

PyTorch入口是`torch.nn.KLDivLoss(reduction='batchmean')`或`torch.nn.functional.kl_div()`。它的参数顺序需要特别注意：

- `input`表示模型分布 \(Q\) 的对数概率，常由`log_softmax(model_logits, dim=...)`产生；
- 默认`log_target=False`时，`target`表示普通概率 \(P\)；
- `log_target=True`时，`target`也使用对数概率；
- `reduction='batchmean'`把所有逐元素项求和后除以batch大小，与批量样本KL散度的平均值一致；默认`'mean'`还会除以类别等元素数量，数值不等于数学定义中的逐样本KL平均。

上面的二分类分布例子可以直接用PyTorch核对：

```python
import torch
from torch.nn import functional as F


# teacher_probability是固定目标分布P；每行概率必须非负且总和为1。
teacher_probability = torch.tensor([[0.75, 0.25]], dtype=torch.float32)

# 两个相同logit经过Softmax后得到模型分布Q=(0.5, 0.5)。
student_logits = torch.tensor([[0.0, 0.0]], dtype=torch.float32)
student_log_probability = F.log_softmax(student_logits, dim=1)

# 第一个参数传log Q，第二个参数传P；batchmean返回这个样本的KL散度。
kl_loss = F.kl_div(
    student_log_probability,
    teacher_probability,
    reduction="batchmean",
)
print(kl_loss.item())  # 约为0.1308
```

知识蒸馏还会用温度 \(T>1\) 平滑教师和学生的类别分布：分别对`teacher_logits / T`和`student_logits / T`计算Softmax与LogSoftmax。常见实现把KL项乘以 \(T^2\)，用于补偿除以温度后梯度尺度缩小的影响。温度和KL权重共同决定软标签对总训练目标的影响，需要通过验证集和当前蒸馏实现确定。PyTorch的输入顺序、对数空间和reduction规则见[KLDivLoss官方文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.KLDivLoss.html)。

Focal Loss在二元交叉熵上加入难度调制。定义正确类别概率为 (p_t)，类别平衡权重为 \(\alpha_t\)，聚焦指数为 \(\gamma\)：

\[
L_{focal}=-\alpha_t(1-p_t)^\gamma\log p_t.
\]

预测已经很容易时 (p_t\) 接近1，因子 \((1-p_t)^\gamma\) 会降低该样本的损失；难样本保持更高权重。TorchVision提供函数式入口`torchvision.ops.sigmoid_focal_loss(inputs, targets, alpha=0.25, gamma=2, reduction='none')`，`inputs`接收logits，`targets`是与其同shape的0/1浮点标签。它适合密集检测或负样本数量远高于正样本的二元判断。`alpha`和`gamma`是需要在验证集上选择的超参数；官方入口见[TorchVision损失算子文档](https://docs.pytorch.org/vision/stable/ops.html#losses)。

### 4.5 DFL与检测任务的组合损失

分布焦点损失（Distribution Focal Loss，DFL）把一条连续边界距离表示为离散位置的概率分布。若目标 (y\in[i,i+1])，只给相邻位置 (i) 和 (i+1) 分配非零监督权重：

\[
w_i=i+1-y,\qquad w_{i+1}=y-i.
\]

模型对各离散位置输出logits，经过Softmax得到分布，再用加权交叉熵训练并用分布期望还原连续距离。PyTorch核心库没有统一的`nn.DFLoss`，其区间数量、距离编码和缩放方式由YOLO等具体模型实现定义，必须阅读当前仓库中的损失代码和配置。

检测总损失会组合多个目标：

\[
L_{total}=\lambda_{cls}L_{cls}
+\lambda_{box}L_{box}
+\lambda_{aux}L_{aux}.
\]

其中 \(L_{cls}\) 可使用BCE或Focal类损失，\(L_{box}\) 可以使用由第5节IoU评价量构造的 \(1-\operatorname{IoU}\)、GIoU Loss、DIoU Loss或CIoU Loss，\(L_{aux}\) 可包含DFL或当前架构定义的目标置信度。IoU本身是重叠评价量；把它变换成需要最小化的函数后，得到的才是训练损失。是否存在某个分量、各权重取值和归一化方式，都要读取当前模型配置与训练代码。排查训练时应分别记录各分量；总损失下降但框回归分量长期不变，说明分类改善掩盖了定位问题。

## 5 交并比（Intersection over Union，IoU）的定义、计算与用途

交并比（Intersection over Union，IoU）是衡量两个区域重叠程度的评价指标。它接收两个区域并输出0到1之间的数值：0表示没有交集，1表示两个区域完全重合。

### 5.1 IoU的交集、并集与取值范围

设预测框覆盖的区域为 \(B_{pred}\)，真实框覆盖的区域为 \(B_{gt}\)，IoU定义为：

\[
\operatorname{IoU}
=\frac{|B_{pred}\cap B_{gt}|}
{|B_{pred}\cup B_{gt}|}.
\]

并集面积不能把重叠区域计算两次，因此：

\[
|B_{pred}\cup B_{gt}|
=|B_{pred}|+|B_{gt}|-|B_{pred}\cap B_{gt}|.
\]

交集面积始终不超过并集面积，所以 \(0\le\operatorname{IoU}\le1\)。IoU只描述重叠比例，不携带类别是否正确、置信度是否可靠或目标中心应向哪个方向移动等信息。

### 5.2 xyxy边界框的IoU计算与简单例子

使用连续坐标的`xyxy`格式时，一个框写成 \((x_1,y_1,x_2,y_2)\)，其中 \((x_1,y_1)\) 是左上角，\((x_2,y_2)\) 是右下角。宽和高为：

\[
w=x_2-x_1,\qquad h=y_2-y_1.
\]

两个框 \(A\) 和 \(B\) 的交集边界为：

\[
\begin{aligned}
x_{\text{left}}&=\max(x_{1A},x_{1B}),\\
y_{\text{top}}&=\max(y_{1A},y_{1B}),\\
x_{\text{right}}&=\min(x_{2A},x_{2B}),\\
y_{\text{bottom}}&=\min(y_{2A},y_{2B}).
\end{aligned}
\]

交集宽高必须截断到非负值：

\[
w_{\cap}=\max(0,x_{\text{right}}-x_{\text{left}}),
\qquad
h_{\cap}=\max(0,y_{\text{bottom}}-y_{\text{top}}).
\]

例如：

\[
A=(1,1,5,5),\qquad B=(3,2,7,6).
\]

两个框的面积都是 \(4\times4=16\)。交集左上角为 \((3,2)\)，右下角为 \((5,5)\)，所以交集面积为 \(2\times3=6\)。并集与IoU为：

\[
|A\cup B|=16+16-6=26,
\]

\[
\operatorname{IoU}(A,B)=\frac{6}{26}\approx0.2308.
\]

这个例子使用连续坐标宽高公式。若某个数据格式把两端像素都计入宽高，面积公式会出现`+1`；训练、评估和部署必须统一坐标约定，不能在同一条链路混用两种算法。

### 5.3 IoU在检测评价、匹配与非极大值抑制中的作用

IoU在目标检测中常参与三个不同流程：

1. **预测框与真实框匹配**：训练标签分配或评估程序计算预测框和真实框的IoU，再根据当前算法规定的阈值决定是否匹配。阈值由模型或评估协议给出，没有适用于所有任务的固定值。
2. **检测结果评价**：评估程序结合类别、置信度排序和IoU匹配条件统计真正例与假正例，再计算精确率、召回率或平均精度。单个IoU数值本身不能代替完整检测指标。
3. **非极大值抑制（Non-Maximum Suppression，NMS）**：NMS比较同类候选框之间的IoU，保留高分框并抑制与它重叠过大的低分框。这里比较的是两个预测框，评价阶段匹配比较的是预测框与真实框。

TorchVision的`torchvision.ops.box_iou(boxes1, boxes2, fmt='xyxy')`接收shape分别为 \((N,4)\) 和 \((M,4)\) 的两组框，输出 \((N,M)\) 的两两IoU矩阵。`box_iou`位于边界框算子部分；`generalized_box_iou_loss`、`distance_box_iou_loss`和`complete_box_iou_loss`位于损失函数部分，这也对应“IoU评价量”和“由它构造的训练损失”之间的边界。[TorchVision边界框与损失算子文档](https://docs.pytorch.org/vision/stable/ops.html)

## 6 ReLU、LeakyReLU、SiLU、GELU与权重初始化

线性层或卷积层完成加权求和。连续多层加权求和仍可合并成一次线性变换，激活函数在层间加入非线性关系，使网络能够表示弯曲的决策边界和复杂特征。

### 6.1 激活函数引入非线性变换的原因

若两层都没有非线性激活：

\[
y=W_2(W_1x+b_1)+b_2
=(W_2W_1)x+(W_2b_1+b_2),
\]

它与单个线性层形式相同。加入激活函数 \(\phi\) 后：

\[
y=W_2\phi(W_1x+b_1)+b_2,
\]

中间输出会按输入区间产生不同响应，网络深度才带来更丰富的函数表达能力。

### 6.2 四种激活函数的负区间梯度与常见使用位置

| 激活函数 | 定义 | 输出范围 | 负区间与常见位置 |
|---|---|---|---|
| ReLU | \(\max(0,x)\) | \([0,+\infty)\) | 负区间梯度为0，卷积网络中常见，计算简单 |
| LeakyReLU | \(\max(\alpha x,x)\) | \(( -\infty,+\infty)\) | 负区间保留斜率 \(\alpha\)，用于减少单元长期零梯度 |
| SiLU | \(x\sigma(x)\) | 约 \([-0.278,+\infty)\) | 平滑且允许小负值，现代YOLO等卷积网络常见 |
| GELU | \(x\Phi(x)\) | 约 \([-0.170,+\infty)\) | 按标准正态分布函数 \(\Phi\) 平滑调节输入，Transformer中常见 |

ReLU输入持续落在负区间时，该位置的局部梯度为0，参数可能难以再把它拉回有效区域。LeakyReLU、SiLU和GELU保留负区间的非零梯度，但会增加不同程度的计算成本。激活函数应与模型结构、训练稳定性和部署后端支持共同选择。

### 6.3 权重初始化对激活和梯度尺度的影响

权重初始化决定训练开始时每层输出和梯度的尺度。权重全部为同一个值会让同层神经元得到相同输出和梯度，难以学习不同特征；随机值范围过大时，激活和梯度会逐层放大；范围过小时，信号会逐层衰减。

Xavier初始化根据输入和输出单元数控制方差，适合两侧响应较对称的激活；He/Kaiming初始化主要根据输入单元数设置方差，常与ReLU及其变体配合。这里需要掌握选择依据，不要求记住每种分布的所有参数。加载预训练权重时，预训练参数会覆盖相应层的随机初始化，新增的检测头或分类头仍需合理初始化。

## 7 二维卷积的参数、输出shape与通道计算

二维卷积让一个小窗口在输入的高度和宽度方向移动。每个输出位置读取局部区域，按卷积核权重加权求和，再产生对应位置的输出。深度学习库实现的“卷积”在数学运算上多为不翻转卷积核的互相关，但参数学习和shape规则与本节目标一致。

### 7.1 卷积核、stride、padding和dilation的输出shape公式

输入shape为 \((N,C_{in},H_{in},W_{in})\)，输出shape为 \((N,C_{out},H_{out},W_{out})\)。高度方向的输出尺寸是：

\[
H_{out}=\left\lfloor
\frac{H_{in}+2p_h-d_h(k_h-1)-1}{s_h}+1
\right\rfloor.
\]

宽度方向替换为对应的 \(W_{in},p_w,d_w,k_w,s_w\)：

\[
W_{out}=\left\lfloor
\frac{W_{in}+2p_w-d_w(k_w-1)-1}{s_w}+1
\right\rfloor.
\]

各参数含义为：

- 卷积核大小（kernel size）\(k\)：每次参与计算的采样点数量；
- 步幅（stride）\(s\)：卷积窗口相邻两次起点之间跨过的输入位置数；
- 填充（padding）\(p\)：输入两侧补入的位置数；
- 空洞率（dilation）\(d\)：相邻卷积核采样点在输入上的间隔系数。

空洞卷积的有效卷积核尺寸为：

\[
k_{eff}=d(k-1)+1.
\]

例如输入高度8，\(k=3,s=2,p=1,d=1\)，输出高度为：

\[
H_{out}=\left\lfloor\frac{8+2-2-1}{2}+1\right\rfloor=4.
\]

PyTorch对`Conv2d`的shape公式和参数定义见[官方Conv2d文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.Conv2d.html)。

### 7.2 groups卷积的通道分组与整除约束

先区分两个容易被统称为“卷积核”的对象。PyTorch `Conv2d`的完整权重shape为：

\[
(C_{out},\ C_{in}/groups,\ k_h,\ k_w).
\]

对一个输出通道来说，完整滤波器包含 \(C_{in}/groups\) 个二维核片。每个二维核片只作用于一个对应的输入通道；各通道的卷积结果相加，再加偏置，形成这个输出通道。`groups=1`且输入为RGB时，一个输出通道的滤波器含有3个二维核片，分别读取R、G、B，最后把三路结果求和。因此“一个二维核片只作用于一个通道”在普通卷积中也成立，完整输出滤波器仍会联合读取全部输入通道。

`groups`把输入通道和输出通道分成相同数量的独立组。每组只读取本组的 \(C_{in}/groups\) 个输入通道，并产生 \(C_{out}/groups\) 个输出通道，最后沿通道维拼接各组结果。因此必须满足：

\[
C_{in}\bmod groups=0,
\qquad
C_{out}\bmod groups=0.
\]

`groups=1`时，每个完整输出滤波器读取全部输入通道；`groups=2`时，两组分别完成卷积，组间没有直接连接。输入本身只有一个通道时，`groups=1`下每个输出滤波器自然也只读取这一个通道，例如灰度图输入可以用多个滤波器产生多个输出特征通道。groups改变通道连接关系，不改变第7.1节的空间输出尺寸公式。

### 7.3 1×1卷积的通道混合与通道数调整

\(1\times1\) 卷积在每个空间位置读取全部允许连接的输入通道，并对通道做加权组合。`groups=1`时，位置 \((h,w)\) 的一个输出通道满足：

\[
y_{c_{out},h,w}
=b_{c_{out}}+
\sum_{c_{in}=1}^{C_{in}}
w_{c_{out},c_{in}}x_{c_{in},h,w}.
\]

它不读取相邻像素，所以不能单独扩大空间感受野。它可以把通道数从 \(C_{in}\) 改为 \(C_{out}\)，常用于瓶颈结构、特征融合和残差投影分支。

### 7.4 一个卷积核只读取一个输入通道的depthwise卷积与通道混合

深度卷积（depthwise convolution）是完整输出滤波器也只读取一个输入通道的情形。设置`groups=C_in`后，权重shape变为：

\[
(C_{out},\ 1,\ k_h,\ k_w).
\]

第二维等于1，说明每个输出通道只有一个二维核片，只能读取所属组的一个输入通道。若通道倍率 (K=1)，则`C_out=C_in`，输入与输出通道一一对应：第0个核只卷积第0个输入通道，第1个核只卷积第1个输入通道。若 (K>1)，则`C_out=K\times C_in`，每个输入通道由 (K) 个不同卷积核产生 (K) 个输出通道，仍然没有跨输入通道求和。

逐点卷积（pointwise convolution）使用`1×1, groups=1`，负责在同一空间位置混合所有输入通道。二者连续使用形成深度可分离卷积：

```text
depthwise：每个通道分别提取空间邻域特征
pointwise：在每个位置重新组合各通道特征
```

忽略偏置时，标准 \(k\times k\) 卷积参数量为

\[
k^2C_{in}C_{out},
\]

深度卷积加逐点卷积的参数量为

\[
k^2C_{in}+C_{in}C_{out}.
\]

例如 \(k=3,C_{in}=32,C_{out}=64\)，标准卷积有18,432个权重，深度可分离卷积有2,336个权重。实际推理速度还受内存访问、算子实现和硬件并行效率影响，应以目标设备测量结果为准。

### 7.5 池化、步幅卷积与感受野

感受野表示某个输出位置在理论上依赖的输入区域。设上一层相邻特征位置在原输入上的间隔为 \(j_{l-1}\)，感受野为 \(r_{l-1}\)，当前层有效卷积核为 \(k_{eff}\)、stride为 \(s_l\)，则：

\[
j_l=j_{l-1}s_l,
\]

\[
r_l=r_{l-1}+(k_{eff}-1)j_{l-1}.
\]

从 \(r_0=1,j_0=1\) 开始，两个`3×3, stride=1`卷积后的理论感受野依次为3和5。若第一层stride为2，输出空间尺寸降低，相邻输出点在原图上相隔2个位置，后续层会以更大的输入间隔扩展感受野。

池化按照固定规则汇聚局部区域，没有可训练卷积核；步幅卷积在降低分辨率的同时学习加权方式。二者都会减少空间位置数，细小目标可能在连续下采样中丢失，因此检测网络会保留不同分辨率的特征层。

## 8 BatchNorm、LayerNorm与Dropout的训练和评估行为

归一化控制中间特征的数值分布，Dropout通过训练期随机屏蔽激活进行正则化。BatchNorm和Dropout含有训练/评估模式差异；模型推理前必须切换到评估模式。

### 8.1 BatchNorm的批次统计量与运行统计量

批归一化（Batch Normalization，BatchNorm）对NCHW输入的每个通道，使用该通道在 (N,H,W) 维上的统计量。训练时先计算当前批次均值 \(\mu_B\) 和方差 \(\sigma_B^2\)，再执行：

\[
\hat{x}=\frac{x-\mu_B}{\sqrt{\sigma_B^2+\epsilon}},
\qquad
y=\gamma\hat{x}+\beta.
\]

\(\epsilon\) 防止分母为零，\(\gamma\) 和 \(\beta\) 是每个通道可学习的缩放和平移参数。默认配置还会更新`running_mean`和`running_var`。评估模式使用保存的运行统计量，不再用当前输入批次重新估计分布。

这条规则带来两个直接现象：训练模式下，同一张图与不同同批样本组合时，输出会受批次统计量影响；评估模式下，固定输入和固定参数得到固定输出。小批量数据的统计波动较大，训练数据与部署数据分布差异明显时，运行统计量也会与实际输入不匹配。PyTorch当前行为与`track_running_stats`例外见[BatchNorm2d官方文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.BatchNorm2d.html)。

### 8.2 LayerNorm的单样本特征归一化

层归一化（Layer Normalization，LayerNorm）对每个样本独立计算指定末尾维度的均值和方差。`normalized_shape=(C,H,W)`时，每个样本在自己的 (C,H,W) 范围内归一化；`normalized_shape=D`用于shape为`(..., D)`的Transformer特征时，对最后一个特征维计算统计量。

LayerNorm在训练和评估时都使用当前样本的输入统计量，不维护BatchNorm式的运行均值和运行方差。它不依赖同一批次中的其他样本，因此适合批量大小变化或序列建模。归一化维度必须和模型定义一致；把NCHW输入直接配置成只归一化通道维时，通道必须位于最后一维，否则shape检查会失败。

### 8.3 Dropout的随机屏蔽与评估模式行为

Dropout以概率 (p) 把训练期激活置零，并把保留元素乘以 \(1/(1-p)\)。若 (p=0.5)，保留下来的元素乘以2，使单个位置跨随机采样的期望值保持不变。

评估模式关闭随机屏蔽，输出直接通过。因为训练时已经完成尺度补偿，推理阶段无需再乘 (1-p)。Dropout没有需要优化器更新的权重，但它的随机掩码会改变本次前向和反向使用的路径。

### 8.4 训练模式和评估模式设置错误的输出表现

推理时遗漏`model.eval()`会产生两类常见现象：Dropout使固定输入的输出反复变化；BatchNorm继续读取当前批次统计量并更新运行统计量，使单张推理和批量推理结果不一致。

`model.eval()`只切换模块的模式标志，不关闭自动微分。推理还应使用`torch.no_grad()`或`torch.inference_mode()`避免保存反向传播所需的计算图，从而减少内存和调度开销。反过来，恢复训练时要调用`model.train()`，让BatchNorm继续更新统计量并重新启用Dropout。

## 9 残差连接的数据关系与shape匹配

残差连接把变换分支的输出和捷径分支相加。它为前向特征和反向梯度提供一条直接路径，是ResNet和许多现代网络的基础结构。

### 9.1 y=F(x)+x的前向与梯度传递关系

直接残差连接定义为：

\[
y=F(x)+x.
\]

其中 (F(x)) 是卷积、归一化和激活等组件构成的变换分支，(x) 经过恒等捷径直接参与相加。对输入求导：

\[
\frac{\partial y}{\partial x}
=\frac{\partial F(x)}{\partial x}+I.
\]

反向传播到这里时，上游梯度可以经过 (F) 的导数路径，也可以经过恒等项 (I) 直接传回较早层。残差结构不能保证所有训练问题自动消失，但它减轻了深层网络必须完全依赖多层连乘导数传递梯度的困难。

### 9.2 直接相加需要满足的shape条件

直接逐元素相加要求两条分支在每个非广播维度上相等。典型残差块不依赖广播，因此要求两边都是相同的 \((N,C,H,W)\)。dtype和device也要满足加法运算要求。

主分支将通道从64改为128，而捷径仍为64通道时，二者无法按对应通道相加；主分支使用stride=2得到 \((N,128,H/2,W/2)\)，捷径仍保留 \((N,64,H,W)\) 时，高宽也不匹配。遇到残差相加报错，应打印两个分支在相加前的完整shape，沿主分支逐层核对首次发生变化的位置。

### 9.3 1×1投影分支对通道数和空间尺寸的调整

需要改变通道或分辨率时，捷径分支可使用投影 (P(x))：

\[
y=F(x)+P(x).
\]

常见投影是`1×1`卷积。它用`out_channels`调整通道数，用与主分支相同的stride调整高宽。例如主分支从 \((N,64,56,56)\) 变为 \((N,128,28,28)\)，捷径使用`1×1, out_channels=128, stride=2`后也得到 \((N,128,28,28)\)，两边即可逐元素相加。

投影分支增加参数量和计算量，只在shape或结构设计需要时使用。若两边shape本来一致，恒等捷径保留了最直接的传递路径。

## 10 PyTorch张量微型实验

下面四个Demo使用Python和PyTorch，每个文件只验证一个知识点。Linux环境可先安装依赖：

```bash
python3 -m pip install torch
```

然后分别保存代码并用`python3 文件名.py`直接运行。Windows PowerShell可把命令中的`python3`替换为`python`。

### 10.1 普通卷积、dilation卷积、groups卷积与depthwise卷积实验

本实验依赖第1.1节的NCHW语义，以及第7.1、7.2、7.4节的输出公式、分组约束和depthwise通道关系。输入固定为 \((1,4,8,8)\)，四个卷积依次验证普通步幅卷积、dilation卷积、groups卷积和每个完整滤波器只读取一个输入通道的depthwise卷积。代码只观察输出shape和权重shape，不训练权重。

```python
# conv_shape_demo.py
import torch
from torch import nn


def print_shape(name: str, layer: nn.Module, input_tensor: torch.Tensor) -> None:
    """执行一个卷积层并打印输入输出shape。

    name用于标识实验；layer持有卷积参数；input_tensor是NCHW输入。
    返回值没有交给后续网络，只用输出shape核对手算结果。
    """
    output_tensor = layer(input_tensor)
    print(f"{name}: {tuple(input_tensor.shape)} -> {tuple(output_tensor.shape)}")


# 固定随机种子只为让权重和输入可复现；本实验的shape不依赖具体数值。
torch.manual_seed(7)
input_tensor = torch.randn(1, 4, 8, 8)

# H_out=floor((8+2*1-1*(3-1)-1)/2+1)=4，W同理。
standard_conv = nn.Conv2d(
    in_channels=4,
    out_channels=6,
    kernel_size=3,
    stride=2,
    padding=1,
)
print_shape("standard", standard_conv, input_tensor)

# dilation=2使3×3卷积核的有效尺寸变成5；padding=2、stride=1保留8×8空间尺寸。
dilated_conv = nn.Conv2d(
    in_channels=4,
    out_channels=6,
    kernel_size=3,
    stride=1,
    padding=2,
    dilation=2,
)
print_shape("dilated", dilated_conv, input_tensor)

# groups=2把4个输入通道和6个输出通道各分为2组；空间公式保持不变。
grouped_conv = nn.Conv2d(
    in_channels=4,
    out_channels=6,
    kernel_size=3,
    stride=1,
    padding=1,
    groups=2,
)
print_shape("grouped", grouped_conv, input_tensor)

# groups=in_channels=4且out_channels=4：每个输出卷积核只读取一个输入通道。
# 权重shape为(4, 1, 3, 3)，其中第二维的1就是每个核可见的输入通道数。
depthwise_conv = nn.Conv2d(
    in_channels=4,
    out_channels=4,
    kernel_size=3,
    stride=1,
    padding=1,
    groups=4,
)
print_shape("depthwise", depthwise_conv, input_tensor)
print("depthwise weight shape:", tuple(depthwise_conv.weight.shape))

try:
    # 4不能被3整除，构造层时输入通道分组失败；异常被接收后程序继续打印原因。
    invalid_grouped_conv = nn.Conv2d(4, 6, kernel_size=3, groups=3)
    print_shape("invalid", invalid_grouped_conv, input_tensor)
except ValueError as error:
    print(f"invalid groups: {error}")
```

运行：

```bash
python3 conv_shape_demo.py
```

普通卷积、dilation卷积和groups卷积的输出shape应依次为`(1, 6, 4, 4)`、`(1, 6, 8, 8)`和`(1, 6, 8, 8)`。depthwise输出为`(1, 4, 8, 8)`，权重shape为`(4, 1, 3, 3)`；第二维的1直接证明每个输出核只读取一个输入通道。最后一个无效构造会报告输入通道无法按3组整除。

### 10.2 logits、Softmax与CrossEntropyLoss输入契约实验

本实验使用第4.3节已经解释的logits、Softmax、类别索引标签和交叉熵。`dim=1`指定沿类别维计算Softmax；两行概率各自求和为1。

```python
# logits_loss_demo.py
import torch
from torch import nn


# 两个样本、三个类别。logits是任意实数，不要求位于0到1或每行和为1。
logits = torch.tensor(
    [[2.0, 1.0, 0.0],
     [0.1, 0.2, 1.8]],
    dtype=torch.float32,
)

# 每个样本给出一个正确类别索引；CrossEntropyLoss的索引标签使用long类型。
labels = torch.tensor([0, 2], dtype=torch.long)
criterion = nn.CrossEntropyLoss()

# 正确路径：损失函数直接接收原始logits。
correct_loss = criterion(logits, labels)

# Softmax只用于获得可解释概率。类别维是dim=1，输出shape仍为(2, 3)。
probabilities = torch.softmax(logits, dim=1)

# 错误路径：概率再次被CrossEntropyLoss当作logits，优化目标已经发生变化。
wrong_loss = criterion(probabilities, labels)

print("probabilities:\n", probabilities)
print("row sums:", probabilities.sum(dim=1))
print("predicted classes:", probabilities.argmax(dim=1))
print("correct loss:", correct_loss.item())
print("loss after premature softmax:", wrong_loss.item())
```

运行：

```bash
python3 logits_loss_demo.py
```

两行概率和应接近1，预测类别为`[0, 2]`。正确损失约为`0.366`，提前Softmax后的损失约为`0.773`；argmax没有改变，训练目标已经改变。

### 10.3 BatchNorm和Dropout训练评估模式对比实验

本实验分别观察两个模块，避免完整网络掩盖状态变化。BatchNorm输入shape为 \((N,C,H,W)\)，`num_features=2`对应两个通道；`affine=False`关闭可学习的 \(\gamma,\beta\)，便于只观察统计量。Dropout使用一维全1输入，便于直接看出哪些元素被置零和放大。

```python
# train_eval_mode_demo.py
import torch
from torch import nn


torch.manual_seed(7)

# 两个样本、两个通道，每个通道有2×2个空间位置。
batch = torch.tensor(
    [
        [[[1.0, 2.0], [3.0, 4.0]],
         [[10.0, 12.0], [14.0, 16.0]]],
        [[[5.0, 6.0], [7.0, 8.0]],
         [[18.0, 20.0], [22.0, 24.0]]],
    ]
)

batch_norm = nn.BatchNorm2d(num_features=2, affine=False)
batch_norm.train()

print("BN running_mean before:", batch_norm.running_mean.clone())

# 训练前向读取当前batch在N、H、W维的统计量，并更新模块持有的运行统计量。
train_output = batch_norm(batch)
print("BN train channel means:", train_output.mean(dim=(0, 2, 3)))
print("BN running_mean after:", batch_norm.running_mean.clone())

batch_norm.eval()
with torch.no_grad():
    # 评估前向读取刚才保存的running_mean/running_var，不再更新它们。
    eval_output_1 = batch_norm(batch)
    eval_output_2 = batch_norm(batch)
print("BN eval outputs equal:", torch.equal(eval_output_1, eval_output_2))

dropout = nn.Dropout(p=0.5)
dropout_input = torch.ones(12)

dropout.train()
# 每次训练前向生成新随机掩码；保留值乘以1/(1-0.5)=2。
dropout_train_1 = dropout(dropout_input)
dropout_train_2 = dropout(dropout_input)
print("Dropout train 1:", dropout_train_1)
print("Dropout train 2:", dropout_train_2)

dropout.eval()
with torch.no_grad():
    # 评估模式关闭随机屏蔽，输入全1时输出也保持全1。
    dropout_eval_1 = dropout(dropout_input)
    dropout_eval_2 = dropout(dropout_input)
print("Dropout eval outputs equal:", torch.equal(dropout_eval_1, dropout_eval_2))
print("Dropout eval output:", dropout_eval_1)
```

运行：

```bash
python3 train_eval_mode_demo.py
```

BatchNorm训练输出每个通道的均值应接近0，`running_mean`从全0变为新值；两次评估输出完全一致。Dropout两次训练输出中的0和2位置会变化，两次评估输出都是全1。

### 10.4 残差相加shape错误与投影分支修正实验

本实验使用第7.3节的`1×1`卷积和第9节的残差shape规则。主分支输出 \((1,16,8,8)\)，原始输入为 \((1,8,16,16)\)，直接相加会失败；投影分支同时把通道改为16并用stride=2把高宽降为8。

```python
# residual_projection_demo.py
import torch
from torch import nn


torch.manual_seed(7)
input_tensor = torch.randn(1, 8, 16, 16)

# 主分支把8通道变为16通道，并通过stride=2把空间尺寸从16×16降为8×8。
main_branch = nn.Conv2d(
    in_channels=8,
    out_channels=16,
    kernel_size=3,
    stride=2,
    padding=1,
)

# 捷径投影只调整shape：1×1卷积改通道，stride=2改空间尺寸。
projection_branch = nn.Conv2d(
    in_channels=8,
    out_channels=16,
    kernel_size=1,
    stride=2,
)

with torch.no_grad():
    main_output = main_branch(input_tensor)
    print("input shape:", tuple(input_tensor.shape))
    print("main shape:", tuple(main_output.shape))

    try:
        # 两边分别是(1,16,8,8)和(1,8,16,16)，通道与空间尺寸都不满足相加条件。
        invalid_output = main_output + input_tensor
        print("invalid output shape:", tuple(invalid_output.shape))
    except RuntimeError as error:
        print("direct addition failed:", error)

    # 投影读取原始输入并产生与主分支相同的shape，相加后shape保持不变。
    shortcut_output = projection_branch(input_tensor)
    residual_output = main_output + shortcut_output
    print("projection shape:", tuple(shortcut_output.shape))
    print("residual output shape:", tuple(residual_output.shape))
```

运行：

```bash
python3 residual_projection_demo.py
```

直接相加会报告维度不匹配；投影输出和最终残差输出均为`(1, 16, 8, 8)`。排查真实网络时也应在相加点打印两条分支的shape，再向前定位改变通道或空间尺寸的层。
