---
title: '[嵌入式AI-视觉算法] PyTorch常用对象、神经网络层、损失函数与优化器API'
published: 2026-09-24T08:22:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍PyTorch常用对象、神经网络层、损失函数与优化器API的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '计算机视觉', '深度学习']
category: '嵌入式AI-视觉算法'
draft: false
passwordProtected: true
lang: zh_CN
---

# 阶段3-2 PyTorch常用对象、神经网络层、损失函数与优化器API

本节把阶段3-1建立的原理映射到PyTorch对象和API。完整调用链是：

```text
创建Tensor → 调整shape、dtype和device → 调用nn.Module
→ 计算损失 → backward累积梯度 → optimizer更新参数
→ scheduler调整学习率 → 保存或恢复训练状态
```

阶段3-1已经解释张量契约、自动微分、卷积、损失和优化算法。本节不重复推导，重点回答每个API接收什么、返回什么、是否共享存储、是否注册状态，以及失败后应该检查哪个对象。

这里的API（Application Programming Interface，应用程序编程接口）指PyTorch对外提供的函数、类、方法和属性。例如`torch.zeros`是函数，`nn.Linear`是类，`tensor.view()`是Tensor对象的方法，`tensor.shape`是属性。学习API时先确认它解决的问题，再看输入、输出和状态变化，不能只记函数名。

## 1 Tensor创建API与底层数据关系

这一部分的函数用于**创建Tensor并确定数据最初放在哪里**。Tensor（张量）是PyTorch保存数据、执行算子和记录自动微分关系的基本对象，可以理解为“带有shape、数据类型、设备等信息的多维数组”。创建Tensor时先判断数据来自哪里：复制现有数据、共享现有存储，或分配一块新存储。

### 1.1 torch.tensor、torch.from_numpy与数据复制共享

`torch.tensor(data, dtype=None, device=None)`主要用于**把现有的Python或NumPy数据复制成一个独立Tensor**。它读取Python标量、序列或其他可转换数据，并创建新的Tensor，因此之后修改原Python列表或NumPy数组，不会修改这个Tensor。

这里的**副本（copy）**是具有独立数据存储的新对象。源数据和副本在创建时数值相同，随后修改其中一方不会改变另一方。**底层存储（storage）**是实际保存元素字节的内存区域；Tensor还会在这块存储之上记录shape、stride、dtype和device等描述信息。

`torch.from_numpy(ndarray)`主要用于**让PyTorch直接使用已有NumPy数组的CPU内存，避免再复制一遍数据**。在dtype和布局受支持时，Tensor与数组共享同一块底层内存：

```text
NumPy ndarray ─┐
               ├→ 同一块CPU存储
PyTorch Tensor ┘
```

**共享存储**表示两个对象使用同一块实际数据内存，只是各自拥有不同的Python对象外壳。**原地操作（in-place operation）**表示直接改写对象当前使用的存储，PyTorch中许多原地方法以`_`结尾，例如`add_()`。一方执行原地写入，另一方会观察到新值。共享关系还意味着：

- Tensor不能比底层存储独立拥有另一份数据；
- NumPy数组为只读时，通过Tensor写入会产生未定义行为，不能这样使用；
- NumPy的负stride数组等布局无法直接转换时，需要先复制成受支持的连续布局；
- 需要彻底断开共享时，对Tensor调用`clone()`，或对NumPy数组调用`copy()`。

从已有Tensor构造新Tensor时也要区分语义。`torch.tensor(existing_tensor)`会复制数据，并生成新的自动微分起点；保留数据且切断计算图可使用`existing_tensor.detach()`，再按是否需要独立存储决定是否追加`clone()`。

### 1.2 torch.zeros、torch.ones与torch.randn的shape、dtype和device

这三个函数主要用于**按照指定shape直接初始化模型输入、中间状态或测试数据**。`torch.zeros`填0，`torch.ones`填1，`torch.randn`填入随机数；三者都会分配新存储：

```python
import torch

zeros = torch.zeros((2, 3), dtype=torch.float32, device="cpu")
ones = torch.ones((2, 3), dtype=torch.float32, device="cpu")
noise = torch.randn((2, 3), dtype=torch.float32, device="cpu")
```

第一个参数定义**输出Tensor**的shape。这里的限制和选项都作用于新创建的输出：`shape`规定输出各维长度，`dtype`规定输出每个元素的数据类型，`device`规定输出存储在CPU还是某个加速设备。它们不约束随后送入模型的权重`w`或偏置`b`；模型运算时会另外检查输入、参数的dtype和device是否兼容。`torch.randn`从均值为0、标准差为1的标准正态分布采样，结果受PyTorch随机数生成器状态影响。

创建模型输入时应明确传入dtype和device，避免依赖进程默认值。整数shape参数只决定维度，不决定元素类型。例如`torch.zeros(2, 3)`默认产生浮点Tensor；若要创建类别索引，应显式使用`dtype=torch.long`。

### 1.3 shape、dtype、device与numel属性

这些属性主要用于**检查Tensor的结构契约并定位shape、类型和设备错误**。属性是对象已经保存的信息，读取它们不会改动Tensor。四个属性回答不同问题：

- `tensor.shape`：每一维的长度，类型为`torch.Size`；
- `tensor.dtype`：每个元素的数据类型；
- `tensor.device`：存储所在设备；
- `tensor.numel()`：全部维度长度的乘积，即元素总数。

shape为\((2,3,4)\)的Tensor具有\(2\times3\times4=24\)个元素。`numel()`不返回字节数；存储有效数据所需字节数可由`tensor.numel() * tensor.element_size()`计算。真实分配还可能涉及存储视图、缓存和分配器管理，不能仅用这个乘积估计整个进程显存。

## 2 Tensor的shape变换、视图与连续存储API

这一部分的函数用于**改变Tensor各维的组织方式**，例如把卷积输出展平成全连接层输入，或把NCHW转换为NHWC。它们有时只修改描述信息，有时必须复制数据，区别会影响内存占用、执行速度以及一方写入后另一方是否变化。

**视图（view）**是共享原Tensor底层存储、但使用另一套shape或stride解释同一批元素的Tensor。**副本（copy）**拥有新存储。比如同一组6个数既可被视为`(2,3)`，也可被视为`(3,2)`；若只改描述信息就是视图，若重新申请内存并搬运6个数就是副本。判断能否创建视图的依据是原shape、stride与目标shape能否描述同一块存储。

### 2.1 view、reshape与flatten的视图复制条件

`tensor.view(*shape)`主要用于**在明确要求共享存储时改变shape**。它要求目标shape与原Tensor的shape和stride兼容；成功时返回共享存储的视图，元素总数必须保持不变：

```python
x = torch.arange(24).view(2, 3, 4)
y = x.view(2, 12)
```

其中`-1`表示让PyTorch根据元素总数推导一个维度。一个shape中最多只能出现一个`-1`。

`tensor.reshape(*shape)`优先返回视图；当前stride不兼容时，它会创建连续副本再变形。因此代码不能依赖`reshape()`一定共享存储。若后续正确性取决于共享关系，应显式使用`view()`并接受不兼容时的错误，或显式调用`contiguous()`说明复制意图。[PyTorch `view()`文档](https://docs.pytorch.org/docs/stable/generated/torch.Tensor.view.html)

`torch.flatten(input, start_dim=0, end_dim=-1)`或`nn.Flatten`把指定范围内的维度合并。分类网络常用`start_dim=1`保留batch维：

\[
(N,C,H,W)\longrightarrow(N,C\times H\times W).
\]

flatten与reshape一样，返回值可能是视图，也可能是副本；调用者应依据API结果使用，不能用是否复制来表达业务语义。

### 2.2 unsqueeze与squeeze的维度插入删除

`unsqueeze()`和`squeeze()`主要用于**补上或删除长度为1的维度，使Tensor满足模型的输入shape**。这里的维度（dimension，dim）是shape中的一个轴；维数也常称为rank，例如`(C,H,W)`的rank为3。`unsqueeze(dim)`插入一个长度为1的维度，不改变元素数量。例如单张CHW图像增加batch维：

\[
(C,H,W)\xrightarrow{\text{unsqueeze}(0)}(1,C,H,W).
\]

`squeeze(dim)`只在指定维长度为1时删除该维；长度不为1时保持不变。无参数`squeeze()`删除所有长度为1的维度，容易在batch大小为1时误删batch维：

```python
logits = torch.randn(1, 10)
safe = logits.squeeze(0)       # 明确删除batch维，结果shape为(10,)
unchanged = logits.squeeze(1)  # 第1维长度为10，shape仍为(1, 10)
```

模型内部应指定dim，让代码直接表达要删除哪一维。输入batch大小变化时，无参数`squeeze()`可能导致输出rank随数据变化，后续导出和部署更难排查。

### 2.3 permute、stride与contiguous的内存关系

`permute()`主要用于**调整各维的排列顺序**，`contiguous()`主要用于**在下游要求连续布局时把逻辑顺序复制成连续存储**。

`stride`表示某一维索引增加1时，底层存储地址需要跨过多少个元素。**连续存储（contiguous storage）**表示Tensor按照当前维度顺序紧密排列，能够用规则的连续地址步进访问。`permute(dims)`重新排列维度并返回共享存储的视图。NCHW转NHWC可以写成：

```python
nhwc = nchw.permute(0, 2, 3, 1)
```

它只改变shape和stride，不立即按NHWC顺序复制元素。若后续`view()`要求连续布局，可能直接报错。

`tensor.is_contiguous()`查询当前内存格式下是否连续。`tensor.contiguous()`在Tensor不连续时分配新存储并按当前逻辑顺序复制；已经连续时可以返回原Tensor。准确的数据流是：

```text
permute改变维度解释和stride
→ 下游确认是否要求连续
→ 只有需要时调用contiguous复制
```

不要在每次`permute()`后机械调用`contiguous()`。复制会消耗内存带宽；下游算子支持当前stride时，保留视图即可。

## 3 设备迁移、NumPy转换与自动微分API

这一部分的函数解决两个问题：**把Tensor移动到计算所需的设备**，以及**控制PyTorch是否记录求导过程**。设备迁移处理数据放在哪里，自动微分API处理后续运算是否记录计算图。两组状态相互独立：GPU Tensor可以不记录梯度，CPU Tensor也可以记录梯度。

**计算图（computation graph）**记录一次前向计算中“哪个结果由哪些运算和输入产生”。反向传播沿这张依赖图应用链式法则，把损失对各参数的梯度算出来。自动微分（automatic differentiation，autograd）就是PyTorch自动建立和使用这张图的机制。

### 3.1 to、cpu与numpy的数据迁移和共享边界

`to()`、`cpu()`和`numpy()`主要用于**跨越设备或框架边界传递数据**。设备（device）指Tensor实际存储和执行运算的位置，例如CPU或`cuda:0`所代表的第一块CUDA GPU。`tensor.to(device=None, dtype=None, non_blocking=False, copy=False)`可同时改变device和dtype。目标属性与当前属性一致且`copy=False`时，它可以返回原Tensor：

```python
device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
input_tensor = input_tensor.to(device=device, dtype=torch.float32)
```

`tensor.cpu()`等价于把Tensor迁移到CPU；本来就在CPU时可以直接返回原对象。GPU到CPU迁移会复制数据。

`tensor.numpy()`默认用于CPU Tensor。若Tensor参与需要梯度的计算，应先调用`detach()`；若位于GPU，还要先调用`cpu()`：

```python
result_array = result_tensor.detach().cpu().numpy()
```

满足共享条件时，返回的NumPy数组与CPU Tensor共享存储。需要独立结果可追加`.copy()`。常见推理边界是：

```text
GPU输出Tensor
→ detach切断自动微分关系
→ cpu复制到主存
→ numpy建立CPU共享视图
→ copy在确实需要独立所有权时复制
```

`non_blocking=True`只是在满足条件时允许异步传输，例如CPU固定页内存与CUDA之间的拷贝；调用返回不等于数据已经可由CPU立即读取。固定页内存和DataLoader传输放到阶段3-3展开。

### 3.2 requires_grad、backward与grad的梯度状态

这三个成员主要用于**声明需要求导的对象、启动反向传播并读取结果**。`requires_grad=True`表示后续可微运算需要建立计算图。只有浮点和复数Tensor可以要求梯度。

**叶子Tensor（leaf tensor）**通常是由用户直接创建、处在计算图起点的Tensor，例如模型参数。**梯度（gradient）**表示损失对某个Tensor每个元素的偏导数；叶子Tensor的反向结果会累加到其`.grad`属性中。

标量损失可直接调用：

```python
loss.backward()
```

非标量输出需要提供与输出shape兼容的外部梯度。它表达向量—雅可比积中来自下游的梯度：

```python
outputs.backward(torch.ones_like(outputs))
```

`backward()`累加梯度，不负责修改参数。重复反向前是否清理`.grad`由训练策略决定。普通训练每次更新前清理；梯度累积训练在多个微批次之间保留。

计算图中间Tensor的`.grad`默认不保留。调试确实需要查看时可调用`retain_grad()`，但这会增加内存占用，不应作为普通训练流程的一部分。

### 3.3 detach、no_grad与inference_mode的适用边界

这一组API主要用于**在局部停止记录梯度**，常见用途是验证、部署推理、日志记录和把结果交给NumPy。`tensor.detach()`针对一个Tensor，`no_grad()`和`inference_mode()`针对一段代码。

`tensor.detach()`返回与原Tensor共享存储的新Tensor，并切断当前自动微分关系。这里的“切断”表示后续运算不会沿detach之前的路径反向求导；数据本身仍然共享。对detach结果执行原地写入也会改变原Tensor数据，因此切断梯度没有提供存储隔离；需要独立存储时使用`detach().clone()`。

`torch.no_grad()`在上下文中关闭反向图记录，适合验证、推理或无需求导的参数操作。上下文结束后，普通自动微分恢复：

```python
with torch.no_grad():
    predictions = model(inputs)
```

`torch.inference_mode()`用于纯推理，进一步关闭视图跟踪和版本计数，开销更低，限制也更强。该模式产生的inference tensor不应带回后续需要自动微分的计算。

`model.eval()`切换BatchNorm、Dropout等模块的行为；`no_grad()`和`inference_mode()`控制自动微分记录。推理通常同时需要：

```python
model.eval()
with torch.inference_mode():
    predictions = model(inputs)
```

## 4 nn.Module的参数注册、子模块组织与状态管理

这一部分的类和方法用于**把多个Tensor运算组织成一个可训练、可迁移、可保存的模型对象**。`nn.Module`是PyTorch模型和层的基类。它负责注册参数、缓冲区与子模块，并让设备迁移、模式切换和状态保存递归作用于整个模型。

这里的**参数（parameter）**是训练中由优化器更新的Tensor，例如卷积权重；**缓冲区（buffer）**是模型需要长期保存和迁移、但不由优化器更新的Tensor，例如BatchNorm运行均值；**子模块（submodule）**是挂在另一个模块内部的层或模型。**注册（registration）**表示`nn.Module`把这些对象纳入自己的管理范围，使`parameters()`、`to()`和`state_dict()`能够递归找到它们。

### 4.1 nn.Module、forward与模型调用流程

`nn.Module`与`forward()`主要用于**定义模型包含哪些层，以及输入依次经过哪些计算**。自定义模型要继承`nn.Module`并在构造函数中先调用`super().__init__()`：

```python
from torch import nn


class Classifier(nn.Module):
    """把最后一维为8的输入映射为3个分类logits。"""

    def __init__(self) -> None:
        super().__init__()
        self.classifier = nn.Linear(8, 3)

    def forward(self, inputs):
        """inputs的shape为(*, 8)，返回shape为(*, 3)的logits。"""
        return self.classifier(inputs)
```

外部使用`model(inputs)`。这次从输入到输出的计算称为**前向传播（forward pass）**。`nn.Module.__call__()`负责执行前向相关hook和内部流程，再调用`forward()`。hook是挂接在模块调用前后、用于调试、监控或修改行为的回调函数。直接写`model.forward(inputs)`会绕过这些机制，普通代码不应这样调用。

代码中的**logits**是分类模型在Softmax或Sigmoid之前输出的原始分数。它们可以是任意实数，不要求各类别之和为1；对应损失函数会在内部完成稳定的概率变换。

`forward()`只描述本次输入怎样流过已注册对象。参数创建应放在`__init__()`，否则每次前向都可能新建参数，优化器也无法稳定持有同一组对象。

### 4.2 Parameter、子模块与缓冲区的注册规则

这一组规则主要用于**确保模型状态不会在训练、设备迁移或保存时遗漏**。把`nn.Parameter`赋给模块属性会注册为可训练参数；把`nn.Module`赋给属性会注册为子模块。优化器通过`model.parameters()`取得这些参数。

不需要梯度但必须跟随模型保存和迁移的状态使用`register_buffer(name, tensor)`，例如BatchNorm的`running_mean`。三类对象的区别是：

| 对象 | 参与parameters() | 进入state_dict | 随model.to迁移 |
|---|---:|---:|---:|
| nn.Parameter属性 | 是 | 是 | 是 |
| 持久buffer | 否 | 是 | 是 |
| 普通Tensor属性 | 否 | 否 | 不保证 |

普通Tensor若只是每次可重新计算的临时量，可以不注册；若它属于模型持久状态，应注册为buffer。把固定掩码或统计量留作普通属性，会导致保存后丢失，或模型迁到GPU后该Tensor仍停留在CPU。

### 4.3 nn.Sequential、nn.ModuleList与自定义forward的适用条件

`nn.Sequential`、`nn.ModuleList`与自定义`forward()`主要用于**组织多层网络并表达它们的调用关系**。`nn.Sequential`既注册子模块，又把前一层输出依次传给后一层：

```python
block = nn.Sequential(
    nn.Linear(8, 16),
    nn.ReLU(),
    nn.Linear(16, 3),
)
```

它适合单路顺序数据流。残差相加、多输入、多输出和条件分支需要自定义`forward()`明确描述控制关系。

`nn.ModuleList`只负责注册一组可索引模块，不自动调用：

```python
self.layers = nn.ModuleList([nn.Linear(8, 8) for _ in range(3)])
```

调用顺序由`forward()`中的循环决定。把层放进普通Python `list`，这些层不会被`nn.Module`注册；`model.parameters()`、`model.to()`和`state_dict()`都看不到它们。[PyTorch `ModuleList`文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.ModuleList)

### 4.4 named_parameters、named_buffers与state_dict的状态范围

这些查询方法主要用于**检查模型实际注册了什么，并取得可保存的状态字典**。`named_parameters()`迭代已注册参数，`named_buffers()`迭代缓冲区，`named_modules()`迭代当前模块及其已注册子模块。它们适合在建模后检查“哪些对象真正属于模型”。

**状态字典（state dictionary，`state_dict`）**是从字符串名称映射到Tensor等状态值的字典。它保存模型的数值状态，不保存模型类的执行代码。键由模块属性路径构成，例如`backbone.0.weight`表示`backbone`子模块中第0层的`weight`。返回字典是**浅拷贝**：字典容器是新的，其中的Tensor仍引用模块状态；若要在内存中保存某一时刻互不影响的独立快照，需要深拷贝或立即序列化到文件。

`state_dict()`不保存`forward()`代码、Python控制流或优化器状态。恢复时必须先用相同模型定义创建对象，再把状态加载进去。[PyTorch `Module`与`state_dict()`文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.Module.html)

## 5 Linear、Conv2d、归一化、激活与Dropout层API

这一部分的类用于**把常见神经网络计算直接封装成可注册的层**：Linear和Conv2d提取或变换特征，归一化层调整特征分布，激活层引入非线性，Dropout在训练时进行随机正则化。预设层的使用顺序是：先确定输入每一维的语义，再填写构造参数，最后手算输出shape并检查参数和状态。阶段3-1已经解释各层原理，本节只给PyTorch映射。

### 5.1 nn.Linear与nn.Conv2d的构造参数和输入输出shape

`nn.Linear`和`nn.Conv2d`主要用于**把输入特征映射成新的特征表示**。

**`nn.Linear`中的`in_features`与`out_features`**

`nn.Linear(in_features, out_features, bias=True)`对输入最后一维执行仿射变换：

\[
y=xW^T+b.
\]

`in_features`表示**每个输入样本交给这一层的特征数量**。如果把Linear理解为一组并排的感知机，那么每个感知机都要读取这`in_features`个数，所以每个感知机拥有`in_features`个权重。`out_features`表示**这一层并排放置多少个感知机，也就是每个样本产生多少个输出特征**。因此：

- 权重`weight`的shape为`(out_features, in_features)`；每一行是一个输出感知机的全部权重；
- 偏置`bias`的shape为`(out_features)`；每个输出感知机有一个偏置；
- 输入shape为`(*, in_features)`，输出shape为`(*, out_features)`；前面的`*`所代表的维度保持不变。

例如`nn.Linear(128, 10)`包含10个输出感知机。每个感知机读取同一个样本的128个输入特征，分别使用128个权重计算一个结果，所以一个`(N,128)`输入得到`(N,10)`输出。忽略偏置时，该层共有`128×10=1280`个权重；开启偏置后再增加10个参数。

输入为`(N,T,128)`时，Linear会对每个`(N,T)`位置上的128维向量重复使用同一组权重，输出为`(N,T,10)`。`out_features=10`只表示这一层最后一维的输出数量，不等于整个网络中所有感知机的总数。`Linear`也不会自动把`(N,C,H,W)`展平；卷积输出接Linear前需要显式使用`Flatten`或其他shape变换。[PyTorch `Linear`文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.Linear.html)

**`nn.Conv2d`中各参数的作用**

当前常用构造形式为：

```python
nn.Conv2d(
    in_channels,
    out_channels,
    kernel_size,
    stride=1,
    padding=0,
    dilation=1,
    groups=1,
    bias=True,
    padding_mode="zeros",
    device=None,
    dtype=None,
)
```

输入通常为`(N,C_in,H,W)`，其中`N`是batch大小，`C_in`是输入通道数，`H`和`W`是空间高宽。各构造参数控制的对象如下：

| 参数 | 主要作用 | 直接影响 |
|---|---|---|
| `in_channels` | 指定输入包含多少个通道，必须与输入shape中的`C_in`一致 | 每个输出滤波器允许读取的输入通道范围 |
| `out_channels` | 指定创建多少个完整输出滤波器 | 输出shape中的`C_out`，也就是输出特征图数量 |
| `kernel_size` | 指定卷积核的空间高宽；`3`表示`3×3`，`(3,5)`表示高3、宽5 | 每个输出位置读取多大的局部区域 |
| `stride` | 指定卷积窗口相邻两次起点跨过多少个输入位置 | 输出高宽及下采样倍率 |
| `padding` | 指定在输入边界外补多少层位置；整数对高宽使用同一值，二元组分别指定高宽 | 输出高宽以及边界位置能读取的区域 |
| `dilation` | 指定卷积核相邻采样点的间隔；有效核尺寸为`dilation×(kernel_size-1)+1` | 感受区域和输出高宽 |
| `groups` | 把输入通道和输出通道划分为多少个互不连接的组 | 通道连接方式及权重数量 |
| `bias` | 为每个输出通道添加一个可训练标量偏置 | 为`True`时增加`out_channels`个参数 |
| `padding_mode` | 指定边界外数值怎样产生，可选`zeros`、`reflect`、`replicate`或`circular` | padding区域的具体数值 |
| `device` | 指定新建权重和偏置所在设备 | 只作用于该层参数的初始放置位置 |
| `dtype` | 指定新建权重和偏置的数据类型 | 只作用于该层参数的初始类型 |

`kernel_size`、`stride`、`padding`和`dilation`都可用一个整数同时设置高宽，也可用`(height, width)`分别设置。`padding='valid'`等价于不填充；`padding='same'`让输出高宽与输入相同，当前`Conv2d`要求此时`stride=1`。空间输出公式见阶段3-1第7.1节。

`device`和`dtype`不会在前向时自动转换输入。例如层权重在CUDA上且输入仍在CPU，前向会因device不一致而失败；需要由调用者把模型和输入迁移到兼容设备。

**`groups`为什么会改变卷积方式**

PyTorch `Conv2d`的权重shape为：

\[
(C_{out},\ C_{in}/groups,\ k_h,\ k_w).
\]

第一维说明有`C_out`个完整输出滤波器。第二维说明**每个输出滤波器只保存并读取`C_in/groups`个输入通道对应的二维核片**。因此`groups`增大后，权重Tensor的第二维缩短，PyTorch也会禁止不同组之间建立连接。这就是设置不同`groups`会形成不同卷积方式的直接原因。

`in_channels`和`out_channels`都必须能被`groups`整除，因为每组固定接收`C_in/groups`个输入通道，并产生`C_out/groups`个输出通道。各组完成计算后，PyTorch沿通道维把结果拼接起来：

```text
输入通道分成groups组
→ 每组只与本组输出通道卷积
→ 各组输出沿通道维拼接
→ 得到C_out个输出通道
```

以`C_in=4`、`C_out=8`、`kernel_size=3`为例：

- `groups=1`：只有一组。8个输出滤波器都读取4个输入通道，权重shape为`(8,4,3,3)`。这称为**标准卷积或普通卷积**，也就是这里所说的“不分离卷积”；空间特征提取与跨通道混合在同一层完成。
- `groups=2`：输入通道分成`[0,1]`和`[2,3]`两组，输出通道也分成各4个。前4个输出只读取输入0、1，后4个输出只读取输入2、3，权重shape为`(8,2,3,3)`。这称为**分组卷积（grouped convolution）**，两组之间没有直接连接。
- `groups=4`：每组只有1个输入通道。若同时设置`out_channels=4`，权重shape为`(4,1,3,3)`，每个输入通道由一个卷积核独立处理；若设置`out_channels=8`，每个输入通道由2个卷积核产生2个输出通道。这个倍率为`K=out_channels/in_channels`。

PyTorch把满足以下条件的层称为**深度卷积（depthwise convolution）**：

\[
groups=C_{in},\qquad C_{out}=K C_{in},\qquad K\in\{1,2,3,\ldots\}.
\]

深度卷积只在每个输入通道内部提取空间特征，不负责让不同输入通道互相组合。`groups=C_in`描述的只是深度卷积这一步。

**深度可分离卷积与标准卷积**

本文的可分离卷积指**深度可分离卷积（depthwise separable convolution）**。它把标准卷积同时完成的两项工作拆成两层：

1. depthwise卷积：使用`groups=C_in`，分别提取每个通道的空间特征；
2. pointwise卷积：使用`1×1, groups=1`，在每个空间位置混合全部通道，并把通道数调整为`C_out`。

```python
from torch import nn


in_channels = 32
out_channels = 64

depthwise_separable = nn.Sequential(
    # 每个输入通道单独使用一个3×3卷积核，不发生跨通道求和。
    nn.Conv2d(
        in_channels,
        in_channels,
        kernel_size=3,
        padding=1,
        groups=in_channels,
        bias=False,
    ),
    # 1×1普通卷积读取全部32个通道，并组合成64个输出通道。
    nn.Conv2d(
        in_channels,
        out_channels,
        kernel_size=1,
        groups=1,
        bias=False,
    ),
)
```

忽略偏置且depthwise通道倍率`K=1`时，标准`k×k`卷积包含`k²C_inC_out`个权重；深度可分离卷积包含`k²C_in+C_inC_out`个权重。它用较少的连接和参数换取计算量下降，但实际速度仍取决于算子实现、内存访问和目标硬件。完整参数量例子见阶段3-1第7.4节。

需要注意名称边界：只写第一层`groups=C_in`得到的是depthwise卷积；depthwise后再接pointwise才构成完整的深度可分离卷积。另一类“空间可分离卷积”会把`k×k`拆成`k×1`和`1×k`，不属于这里的`groups`设置问题。[PyTorch `Conv2d`文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.Conv2d.html)

构造成功只能证明参数满足整除等静态条件；运行前向时还会检查输入rank、通道数、dtype和device。

### 5.2 nn.BatchNorm2d与nn.LayerNorm的参数、缓冲区和模式状态

这两个层主要用于**控制中间特征的数值分布，改善训练稳定性**。归一化（normalization）先在指定的一组数中计算均值和方差，再把组内每个值变换为：

\[
\hat{x}=\frac{x-\mu}{\sqrt{\sigma^2+\epsilon}},
\qquad
y=\gamma\hat{x}+\beta.
\]

两者最重要的区别是：**BatchNorm2d按通道跨样本统计，LayerNorm按`normalized_shape`指定的末尾维度分别统计。**二者都保持输入shape，差别在于哪些元素共同使用同一组均值\(\mu\)和方差\(\sigma^2\)。

**`nn.BatchNorm2d`的统计范围**

`nn.BatchNorm2d(num_features, eps=1e-5, momentum=0.1, affine=True, track_running_stats=True)`接收NCHW输入，`num_features`必须等于通道数\(C\)。对每一个固定通道\(c\)，BatchNorm2d收集batch内所有样本及所有空间位置的值，即沿\((N,H,W)\)三个维度计算：

\[
\mu_c=\frac{1}{NHW}
\sum_{n=1}^{N}\sum_{h=1}^{H}\sum_{w=1}^{W}x_{n,c,h,w}.
\]

方差也在同样的\((N,H,W)\)范围内计算。不同通道分别拥有自己的均值、方差、缩放\(\gamma_c\)和平移\(\beta_c\)。因此可以把它理解为“同一个通道在所有样本和所有空间位置上一起归一化”。这里还包含每张特征图的全部\(H\times W\)个位置。

以输入shape`(N,C,H,W)=(10,5,2,2)`为例：

- 固定通道0，参与统计的是`10×2×2=40`个数；
- 通道1到通道4各自再计算一组统计量；
- 一共得到5组均值和方差，每组都由40个数计算。

所以“BatchNorm对`(10,2,2)`进行归一化，进行5次”这个理解是正确的。更准确地说，5个通道分别沿\((N,H,W)=(10,2,2)\)计算一组统计量，再用本通道的统计量变换其中40个值。

BatchNorm2d的默认状态包括：

- 可训练参数`weight`和`bias`，shape都是`(C)`，分别对应每个通道的\(\gamma_c\)与\(\beta_c\)；
- 持久缓冲区`running_mean`、`running_var`和`num_batches_tracked`；
- 训练模式使用当前batch统计量，并更新运行均值和运行方差；
- 评估模式默认使用训练期间保存的运行统计量。

因此，训练模式下某个样本的输出会受到同一batch中其他样本影响。batch很小时，统计量使用的样本较少，波动会增大。这里的`momentum`用于更新运行统计量，含义不同于优化器动量。训练/评估机制见阶段3-1第8.1节。[PyTorch `BatchNorm2d`文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.BatchNorm2d.html)

**`nn.LayerNorm`的统计范围**

`nn.LayerNorm(normalized_shape, eps=1e-5, elementwise_affine=True)`只在输入的最后若干维计算统计量。归一化多少个末尾维度，由`normalized_shape`包含几个维度决定：

- `normalized_shape=5`：要求输入最后一维长度为5，只归一化最后一维；
- `normalized_shape=(5,2,2)`：要求输入最后三维正好是`(5,2,2)`，同时归一化这三维；
- `normalized_shape=(2,2)`：要求输入最后两维是`(2,2)`，只归一化空间高宽。

对shape为`(10,5,2,2)`的输入使用`nn.LayerNorm((5,2,2))`时，每个样本\(n\)单独收集自己的全部\((C,H,W)\)元素：

\[
\mu_n=\frac{1}{CHW}
\sum_{c=1}^{C}\sum_{h=1}^{H}\sum_{w=1}^{W}x_{n,c,h,w}.
\]

此时：

- 第0个样本使用自己的`5×2×2=20`个数计算一组均值和方差；
- 其他9个样本分别使用各自的20个数计算；
- 一共计算10组互相独立的均值和方差。

所以“LayerNorm对每个样本的`(5,2,2)`进行归一化，总共进行10次”在`nn.LayerNorm((5,2,2))`配置下是正确的。这里的“所有特征”具体指一个样本中的20个标量，即5个通道与每个通道的4个空间位置，并非只取5个通道各自的一个代表值。

需要保留一个边界：LayerNorm并不固定归一化整个样本，它严格归一化`normalized_shape`指定的末尾维度。例如对同一个NCHW输入使用`nn.LayerNorm((2,2))`时，每个`(n,c)`对应的`2×2`空间区域单独计算统计量，一共计算`N×C=10×5=50`组。直接使用`nn.LayerNorm(5)`会要求输入最后一维长度为5，而该输入最后一维\(W=2\)，因此shape检查会失败。

若目标是在每个空间位置只对5个通道归一化，可先把NCHW排列为NHWC，再使用`nn.LayerNorm(5)`：

```python
from torch import nn


channel_layer_norm = nn.LayerNorm(5)

# 输入从(N,C,H,W)变为(N,H,W,C)，最后一维长度为5。
features_nhwc = features_nchw.permute(0, 2, 3, 1)

# 每个(n,h,w)位置分别对5个通道计算均值和方差。
normalized_nhwc = channel_layer_norm(features_nhwc)

# 如果后续卷积仍要求NCHW，再把维度顺序转换回来。
normalized_nchw = normalized_nhwc.permute(0, 3, 1, 2)
```

在`(10,5,2,2)`例子中，这种写法会对每个`(n,h,w)`位置的5个通道归一化，共计算`10×2×2=40`组统计量。

LayerNorm默认拥有与`normalized_shape`相同shape的逐元素缩放和平移参数。`LayerNorm((5,2,2))`的`weight`和`bias`分别含20个值；BatchNorm2d的`weight`和`bias`分别只有5个值。LayerNorm不维护运行均值和运行方差，训练模式与评估模式都从当前输入中计算统计量。[PyTorch `LayerNorm`文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.LayerNorm.html)

把`(10,5,2,2)`的核心区别压缩为一张表：

| 配置 | 每组统计量包含的值 | 统计组数 | 是否混合不同样本 | 默认评估行为 |
|---|---:|---:|---|---|
| `BatchNorm2d(5)` | 每个通道的`10×2×2=40`个值 | 5 | 是 | 使用运行统计量 |
| `LayerNorm((5,2,2))` | 每个样本的`5×2×2=20`个值 | 10 | 否 | 继续使用当前输入统计量 |
| NHWC上的`LayerNorm(5)` | 每个空间位置的5个通道值 | `10×2×2=40` | 否 | 继续使用当前输入统计量 |

>BN 在推理时比 LN 快，是因为 BN 在训练时维护了全局均值和方差并在推理时直接固化使用(但这种固化也会导致要求训练的样本和推理的样本的域相差不大)，而 LN 因样本间差异过大无法固化全局量、推理时必须逐个样本实时计算。

### 5.3 nn.ReLU、nn.SiLU、nn.GELU与nn.Dropout的shape和状态行为

ReLU、SiLU和GELU是**激活函数**，主要用于在层与层之间引入非线性；没有这些非线性，多层线性变换仍可合并成一次线性变换。`nn.ReLU(inplace=False)`、`nn.SiLU(inplace=False)`和`nn.GELU()`都逐元素变换，输出shape与输入相同。它们没有普通可训练参数。`inplace=True`表示允许直接覆盖输入使用的部分存储，但自动微分仍需要原值时可能报错；教学和普通模型代码优先使用默认非原地版本。

Dropout是一种正则化方法，主要用于训练时随机屏蔽一部分特征，降低模型对特定神经元组合的依赖。`nn.Dropout(p=0.5)`保持shape。训练模式按概率`p`屏蔽元素并缩放保留值，评估模式原样返回。`p`是丢弃概率，允许范围为0到1；`p=0`等价于不屏蔽。模式切换只改变前向行为，不增加可训练参数。

这些层可通过`list(module.parameters())`检查参数数量，通过`module.training`检查当前模式。不要根据“层名字里有Norm或Dropout”猜状态，应检查实际模块对象。

## 6 池化、上采样、Flatten与Identity层API

这一组层主要用于**改变特征图的空间尺寸、维度组织或网络连接方式**。池化压缩空间尺寸，上采样放大空间尺寸，Flatten合并维度，Identity保留原输入。每次构造都应写出输入和输出shape，避免直到Linear处才发现特征数计算错误。

### 6.1 nn.MaxPool2d与nn.AdaptiveAvgPool2d的输出shape

池化（pooling）是在局部窗口内汇总多个数值，用于缩小特征图并扩大后续神经元对应的输入区域。`nn.MaxPool2d(kernel_size, stride=None, padding=0, dilation=1, ceil_mode=False)`在每个通道内取局部最大值。未提供`stride`时，它默认等于`kernel_size`。输入和输出都是NCHW，通道数不变。

`ceil_mode=False`使用向下取整的输出尺寸；`True`允许窗口覆盖到右侧或下侧边界附近并使用向上取整规则。它会直接改变输出shape，不能只当成数值计算选项。

`nn.AdaptiveAvgPool2d(output_size)`直接指定输出高宽。例如：

```python
pool = nn.AdaptiveAvgPool2d((1, 1))
```

任意合法输入`(N,C,H,W)`都会得到`(N,C,1,1)`。这适合在分类头前消除对固定输入高宽的依赖；通道数仍保持\(C\)。

### 6.2 nn.Upsample的size、scale_factor、mode与align_corners

上采样（upsampling）主要用于**把较小的图像或特征图生成到更大的空间尺寸**，常见于分割解码器和检测特征融合。`nn.Upsample(size=None, scale_factor=None, mode='nearest', align_corners=None)`通过插值扩大或缩小空间尺寸。插值表示根据已有采样点计算新位置的值。`size`直接给目标尺寸，`scale_factor`给缩放倍数。业务契约要求固定输出shape时使用`size`；要求按输入倍数缩放时使用`scale_factor`。

常用模式包括：

- `nearest`：最近邻，适合类别ID、离散掩码或无需平滑的特征；
- `bilinear`：二维双线性插值，适合连续图像或特征；
- `bicubic`：二维三次插值，计算量更高。

`align_corners`只适用于线性、双线性、双三次和三线性模式。`True`让输入输出角点中心对齐，采样坐标依赖输入尺寸；`False`采用边界对齐方式，在相同`scale_factor`下更独立于输入尺寸。训练、导出和部署必须保持同一设置，否则shape相同也会产生不同数值。

### 6.3 nn.Flatten与nn.Identity的模型衔接用途

`Flatten`主要用于**把连续的若干维合并成一维**，`Identity`主要用于**在配置关闭某个可选层时保留统一调用接口**。`nn.Flatten(start_dim=1, end_dim=-1)`常放在卷积特征与Linear之间。输入`(N,C,H,W)`变成`(N,C×H×W)`。若前面的空间尺寸会随输入变化，固定`Linear.in_features`就会失配；可先用AdaptiveAvgPool固定空间尺寸。

`nn.Identity(*args, **kwargs)`原样返回输入，没有参数。它适合配置化模型中的空操作，例如：

```python
self.dropout = nn.Dropout(p) if p > 0 else nn.Identity()
```

这样`forward()`始终调用`self.dropout(x)`，无需额外分支。Identity没有修正shape或dtype的能力，输入契约错误仍会传给下一层。

## 7 分类、回归与检测损失函数API

这一部分的函数用于**把模型预测与正确答案之间的差异变成一个可反向传播的数值**。这个数值称为损失（loss），训练程序通过减小它来调整模型参数。阶段3-1第4节已经解释常用损失公式，本节讨论PyTorch输入、target、权重和reduction的具体契约。

这里的**input**通常是模型预测，**target**是监督标签或目标值，**logits**是尚未经过概率归一化的分类原始分数，**reduction（归约）**表示怎样把逐样本或逐元素损失合并成最终输出。分类、回归和检测的目标含义不同，因此不能只看两个Tensor的shape相近就混用损失函数。

### 7.1 nn.CrossEntropyLoss的logits、类别索引、weight与ignore_index

`nn.CrossEntropyLoss(weight=None, ignore_index=-100, reduction='mean')`主要用于**一个样本只属于一个类别的互斥多分类**，例如一张图只判为猫、狗或鸟中的一类。它内部组合了LogSoftmax与负对数似然计算，因此输入应直接传logits。类别索引模式下：

- input是logits，shape为`(N,C)`或`(N,C,d1,...,dK)`；
- target去掉类别维，shape为`(N)`或`(N,d1,...,dK)`；
- target dtype为`torch.long`；
- 每个有效类别索引位于`[0,C)`。

`weight`是shape为`(C)`的一维类别权重，缩放对应类别样本的损失。它不是每个样本任意指定的权重。

`ignore_index`指定一个不参与损失和梯度的target值，常用于分割中的无效像素或序列padding。使用`reduction='mean'`时，平均只统计未忽略位置并结合类别权重计算分母，不能简单除以全部元素数量。

### 7.2 nn.BCEWithLogitsLoss的同shape标签、weight与pos_weight

`nn.BCEWithLogitsLoss(weight=None, pos_weight=None, reduction='mean')`主要用于**二分类、多标签分类和逐像素二值判断**。BCE是Binary Cross Entropy（二元交叉熵）；该类把Sigmoid和BCE组合在一次数值稳定的计算中。input是logits，target是0到1之间的浮点值，并与input具有相同shape。

二分类可使用`(N,1)`，多标签分类使用`(N,C)`，二值分割使用`(N,1,H,W)`。多标签中的每个类别独立成立，不使用单个整数类别索引。

`weight`按广播规则缩放损失元素；`pos_weight`只缩放正标签项。多标签分类中`pos_weight`沿类别维给出。对`(N,C,H,W)`输入，若每个类别在所有batch和空间位置使用同一正类权重，可使用`(C,1,1)`。广播结果必须逐维核对，shape能广播不代表语义正确。

### 7.3 nn.MSELoss、nn.L1Loss与nn.SmoothL1Loss的输入契约

这三个损失主要用于**比较连续数值预测与目标之间的误差**，例如深度、坐标、温度或回归分数。`nn.MSELoss`计算平方误差，对大误差惩罚更强；`nn.L1Loss`计算绝对误差；`nn.SmoothL1Loss(beta=1.0)`在小误差区域使用平滑二次形式，在大误差区域使用线性形式。input和target应具有完全相同的业务shape。

PyTorch的部分逐元素损失允许广播。例如`(N,1)`预测与`(N)`标签会广播成`(N,N)`，每个预测与所有标签交叉比较，程序可能只给警告或继续执行。训练前应断言：

```python
assert predictions.shape == targets.shape
```

`SmoothL1Loss.beta`与误差使用相同单位。坐标已归一化到0～1时，`beta=1`覆盖整个常见范围；像素坐标下`beta=1`只覆盖绝对误差小于1像素的区域。参数值要结合标签尺度选择。

### 7.4 reduction对损失输出shape和梯度尺度的影响

`reduction`主要用于**决定损失函数返回一组逐元素结果、总和还是平均值**。它直接决定输出shape，并按同样比例影响反向梯度。设逐元素损失为`element_loss`：

- `reduction='none'`保留逐元素或逐位置结果；
- `'sum'`返回所有有效项之和；
- `'mean'`按具体API定义返回平均值。

若每个样本有效位置数不同，先使用`none`和mask选择有效项，再用明确分母归一化：

\[
L=\frac{\sum_i m_i\ell_i}{\sum_i m_i},
\]

其中\(m_i\)为0或1的有效标记。这样batch中padding数量改变时，损失尺度不会被无效位置稀释。

多任务训练中\(L=L_{cls}+\lambda L_{reg}\)的\(\lambda\)作用于reduction后的量。改变某一项从mean到sum会同时改变其梯度尺度，不能只比较打印出来的损失数值。

### 7.5 IoU派生损失、DFL与模型仓库自定义损失的API边界

这一类函数主要用于**训练检测框的位置与边界**。IoU是Intersection over Union（交并比），本身是框重叠程度的评价量，见阶段3-1第5节；训练代码常把它变换成可最小化的损失。由IoU构造的`1-IoU`、GIoU、DIoU和CIoU损失可以来自TorchVision或模型仓库。TorchVision提供`generalized_box_iou_loss`、`distance_box_iou_loss`和`complete_box_iou_loss`等函数；输入框格式和reduction要读取当前函数文档。

分布焦点损失（Distribution Focal Loss，DFL）把连续的框边界距离表示为相邻离散区间上的概率分布，用于更细致地回归框位置。PyTorch没有统一的`torch.nn.DFLoss`；YOLO仓库会定义离散区间数量、目标编码、Softmax维度和组合权重。阅读项目时先找到总损失入口，再沿调用关系确认各分量输入shape和归一化方式，不能只凭类名推断。[TorchVision损失算子文档](https://docs.pytorch.org/vision/stable/ops.html#losses)

## 8 SGD、Adam、AdamW与梯度更新API

这一部分的API用于**读取参数梯度并按照优化算法修改模型参数**。优化器（optimizer）保存参数引用、参数组配置和历史状态；`SGD`、`Adam`与`AdamW`的差别主要体现在怎样利用当前梯度和历史统计量计算更新量。算法原理见阶段3-1第3节，本节关注对象何时创建、梯度何时读取及状态怎样保存。

### 8.1 优化器构造、参数组与优化器状态

优化器构造主要完成两件事：**指定要更新哪些参数，并为这些参数配置学习率等超参数**。最简单的构造方式是：

```python
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=1e-3,
    weight_decay=1e-2,
)
```

`model.parameters()`必须包含需要更新的注册参数，因此优化器应在模型结构完成并迁移到目标设备后创建。模型后续新增参数时，现有优化器不会自动接管。

**参数组（parameter group）**是共享一组优化器配置的参数集合，它允许主干和分类头使用不同学习率或权重衰减。参数组配置的是更新规则，参数本身仍由模型拥有。用法如下：

```python
optimizer = torch.optim.SGD(
    [
        {"params": model.backbone.parameters(), "lr": 1e-3},
        {"params": model.head.parameters(), "lr": 1e-2},
    ],
    momentum=0.9,
    weight_decay=1e-4,
)
```

每个参数只能出现在一个参数组中。`optimizer.param_groups`保存当前组配置；`optimizer.state`按参数保存SGD动量或Adam矩估计。状态在第一次`step()`后才可能实际创建。

### 8.2 zero_grad、backward与step的调用顺序

这三个调用组成一次参数更新：`zero_grad()`清理旧梯度，`backward()`计算并累加新梯度，`step()`读取梯度更新参数。普通训练迭代遵循：

```python
optimizer.zero_grad(set_to_none=True)
predictions = model(inputs)
loss = loss_function(predictions, targets)
loss.backward()
optimizer.step()
```

`zero_grad(set_to_none=True)`把已有`.grad`设为`None`。参数本轮没有收到梯度时，它的`.grad`继续为`None`，优化器通常跳过该参数。`set_to_none=False`创建或保留零梯度Tensor，优化器看到的是数值为0的梯度；两种状态在手工检查和部分优化器行为上不同。[PyTorch优化器文档](https://docs.pytorch.org/docs/stable/optim.html)

`backward()`只累积梯度，`step()`才读取梯度并更新参数。漏掉`zero_grad()`会把前一轮梯度带入本轮；漏掉`step()`则损失和梯度都存在，参数保持不变。

### 8.3 梯度累积的清零时机、损失缩放与更新频率

梯度累积主要用于**在显存无法容纳大batch时，用多个较小的微批次近似一次大batch更新**。batch是一次共同计算损失的一组样本；微批次（micro-batch）是梯度累积期间单次前向和反向使用的更小样本组。设每累计\(K\)个等大小微批次更新一次，并希望得到大batch平均损失对应的梯度。每个微批次要反向`loss / K`，第\(K\)次反向后才执行`step()`：

```python
optimizer.zero_grad(set_to_none=True)

for micro_index, (inputs, targets) in enumerate(micro_batches):
    loss = loss_function(model(inputs), targets) / accumulation_steps
    loss.backward()

    if (micro_index + 1) % accumulation_steps == 0:
        optimizer.step()
        optimizer.zero_grad(set_to_none=True)
```

若最后不足\(K\)个微批次，需要根据实际累积数量调整分母或提前规划数据长度。batch大小不同、有效样本数不同或损失使用sum reduction时，不能直接套用`loss / K`，应按实际有效元素总数归一化。

### 8.4 梯度裁剪在反向传播和参数更新之间的位置

梯度裁剪主要用于**限制一次更新前的梯度大小，降低梯度突然爆炸导致数值不稳定的风险**。裁剪读取已经产生的`.grad`，所以位于`backward()`之后、`step()`之前：

```python
loss.backward()
total_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
optimizer.step()
```

`clip_grad_norm_`把所有参数梯度视为整体，返回裁剪前的总范数。它限制单次异常梯度，不修复长期发散的学习率、错误标签或数值溢出。使用混合精度GradScaler时，应先反缩放梯度，再执行裁剪；相关完整流程放到阶段3-3。

## 9 学习率调度器的状态与调用时机

这一部分的API用于**在训练过程中按计划或验证结果改变学习率**。学习率调度器（learning-rate scheduler）持有优化器引用，并按自己的规则修改各参数组`lr`。学习率决定每次参数更新的步幅；训练前期可使用较大值快速移动，后期常降低它以减小震荡。不同调度器把一次`step()`解释为不同时间单位，调用位置必须读取具体类的契约。

### 9.1 按epoch推进的StepLR、MultiStepLR与CosineAnnealingLR

这一组调度器主要用于**按照预先设定的训练进度更新学习率**。epoch表示训练集被完整遍历一次。`StepLR(optimizer, step_size, gamma)`每经过`step_size`个调度周期把学习率乘以`gamma`。若每个epoch结束调用一次，则周期单位就是epoch：

```python
for epoch in range(num_epochs):
    train_one_epoch(...)
    validate(...)
    scheduler.step()
```

`MultiStepLR(optimizer, milestones, gamma)`在`milestones`指定的周期编号处衰减。milestones应为递增整数列表。

`CosineAnnealingLR(optimizer, T_max, eta_min=0.0)`让学习率按余弦曲线从初始值变化到`eta_min`。当它按epoch调用时，`T_max`表示周期中的epoch数；若项目按batch调用，同一个参数就表示优化器更新次数。配置文件必须同时记录数值和调用频率。

现代PyTorch中常规顺序是先执行`optimizer.step()`，再执行`scheduler.step()`。反向顺序可能跳过初始学习率值，并触发警告。

### 9.2 按优化器更新推进的OneCycleLR

`OneCycleLR`主要用于**按每次参数更新精细安排一个先升后降的学习率周期**。这里的一次优化器更新是一次真实的`optimizer.step()`；它和“读取一个batch”并不总是相同，因为梯度累积会读取多个微批次后才更新一次。调用方式如下：

```python
for inputs, targets in train_loader:
    optimizer.zero_grad(set_to_none=True)
    loss = loss_function(model(inputs), targets)
    loss.backward()
    optimizer.step()
    scheduler.step()
```

构造时可用`epochs`与`steps_per_epoch`共同确定总更新次数，或直接给`total_steps`。梯度累积时，`steps_per_epoch`应对应真正执行`optimizer.step()`的次数；每个微批次都调用会让调度计划提前结束。

### 9.3 由验证指标驱动的ReduceLROnPlateau

`ReduceLROnPlateau`主要用于**在验证指标停止改善时自动降低学习率**。这里的plateau表示指标进入平台期，即若干次评估没有达到配置要求的改善幅度。它接收指标值：

```python
validation_loss = validate(...)
scheduler.step(validation_loss)
```

`mode='min'`用于验证损失等越小越好的指标，`mode='max'`用于准确率等越大越好的指标。`patience`按调用次数计数；每个epoch验证一次时，它代表epoch数，每个若干epoch才验证一次时，它代表验证事件数。

调度器状态也属于训练轨迹。恢复训练时漏掉`scheduler.state_dict()`，内部周期计数、最佳指标和等待次数会被重置。

## 10 模型模式、检查点保存与状态恢复API

这一部分的API用于**切换训练与评估行为，并把训练状态保存到磁盘后恢复**。模型模式决定模式敏感层的前向行为，检查点决定程序重启后能恢复哪些状态。推理只需要模型参数和缓冲区；继续训练还需要优化器、调度器和训练进度。

**检查点（checkpoint）**是训练过程中某一时刻保存的状态集合，作用类似“存档”。**序列化（serialization）**是把内存中的Tensor、字典等对象编码为可写入文件的数据；反序列化则从文件重建这些对象。

### 10.1 model.train与model.eval的递归模式切换

`model.train()`与`model.eval()`主要用于**递归切换所有模式敏感层的前向规则**。`model.train(mode=True)`把当前模块及所有已注册子模块的`training`标志设为给定值。`model.eval()`等价于`model.train(False)`。

它们影响BatchNorm、Dropout等读取`training`标志的模块，对Linear、Conv2d、ReLU等没有数值模式差异。模式切换不修改`requires_grad`，也不关闭计算图。

验证常用：

```python
model.eval()
with torch.inference_mode():
    validation_output = model(validation_input)
```

验证结束继续训练前调用`model.train()`。若忘记恢复，Dropout保持关闭，BatchNorm也不再更新运行统计量。

### 10.2 model、optimizer、scheduler与训练进度的检查点内容

这一组状态用于**让恢复后的程序继续原来的训练轨迹**。可继续训练的检查点至少包含：

```python
checkpoint = {
    "epoch": current_epoch,
    "model": model.state_dict(),
    "optimizer": optimizer.state_dict(),
    "scheduler": scheduler.state_dict(),
    "best_metric": best_metric,
}
torch.save(checkpoint, "checkpoint.pt")
```

使用自动混合精度时还要保存GradScaler状态；要求精确续跑时还可保存随机数生成器状态和采样器进度。保存哪些字段取决于“恢复后要继续什么”：

- 只做推理：模型state_dict与模型配置；
- 继续微调但允许新优化轨迹：模型state_dict；
- 从中断点继续原训练：模型、优化器、调度器、epoch及相关训练状态。

推荐保存state_dict，不直接保存整个`nn.Module`对象。整个对象依赖Python类路径和Pickle反序列化环境，跨代码版本迁移更脆弱。

### 10.3 torch.save、torch.load、map_location与weights_only

`torch.save()`与`torch.load()`主要用于**把检查点写入文件并从文件读回**。`torch.save(obj, path)`序列化Tensor、state_dict及由这些对象组成的常见容器。`torch.load(path, map_location=..., weights_only=...)`读取对象。

加载训练检查点时先放在CPU：

```python
checkpoint = torch.load(
    "checkpoint.pt",
    map_location="cpu",
    weights_only=True,
)
```

`map_location='cpu'`把保存时的CUDA存储映射到CPU，避免加载过程直接占用对应GPU。随后创建模型、加载状态，再调用`model.to(target_device)`。

当前PyTorch在未显式提供`pickle_module`时默认使用`weights_only=True`，只允许构造Tensor、基本类型、字典及安全列表中的对象。它缩小任意代码执行风险，仍不能把不可信检查点视为安全数据；恶意文件还可能造成资源耗尽或构造危险的下游数据结构。[PyTorch序列化说明](https://docs.pytorch.org/docs/stable/notes/serialization.html)、[`torch.load`文档](https://docs.pytorch.org/docs/stable/generated/torch.load.html)

### 10.4 load_state_dict的strict、missing_keys与unexpected_keys

`load_state_dict()`主要用于**把字典中的参数和缓冲区复制到已经创建好的模型对象中，并报告名称是否匹配**。`model.load_state_dict(state_dict, strict=True)`要求待加载键与当前模型state_dict键完全一致。成功时返回包含`missing_keys`和`unexpected_keys`的命名元组。

`missing_keys`表示当前模型期望存在、但检查点没有提供的键；`unexpected_keys`表示检查点提供了、但当前模型没有对应位置的键。它们常用于判断模型结构或参数命名是否发生变化。

`strict=False`允许当前模型缺少检查点键或拥有新增键：

```python
load_result = model.load_state_dict(model_state, strict=False)
print("missing:", load_result.missing_keys)
print("unexpected:", load_result.unexpected_keys)
```

调用者必须检查这两个列表。分类头更换时出现预期的缺失键可以接受；主干大量缺失通常意味着命名或模型版本错误。`strict=False`不会忽略同名参数shape冲突，shape不一致仍会报错。

恢复完整训练时先创建模型并加载模型状态，再创建优化器和调度器，随后加载优化器、调度器state_dict。PyTorch文档特别提醒：优化器状态应在学习率调度器对象初始化后加载，否则调度器初始化可能覆盖已经恢复的学习率。

## 11 随机种子、DataLoader工作进程与确定性配置

这一部分的API用于**尽量让同一实验重复运行时得到一致结果**。可复现性（reproducibility）要求控制所有随机源，并限定软件版本、设备和算法实现。固定一个种子只能固定对应随机数生成器产生的序列，不能消除所有平台和并行算法差异。

### 11.1 torch、Python与NumPy随机数生成器的种子

随机数生成器（Random Number Generator，RNG）根据内部状态产生一串伪随机数；**随机种子（seed）**用于初始化这份状态。相同实现从相同种子开始，并按相同顺序调用随机操作，才会得到相同序列。一个进程中常见随机源至少有三个：

```python
import random
import numpy as np
import torch

seed = 2026
random.seed(seed)
np.random.seed(seed)
torch.manual_seed(seed)
```

`torch.manual_seed()`设置PyTorch CPU和CUDA设备的随机种子。使用独立`torch.Generator`对象时，还要对该Generator单独`manual_seed()`。NumPy新的`Generator`实例也保存独立状态，调用全局`np.random.seed()`不会修改已经创建的独立Generator。

设置种子后不要在不相关代码中额外消耗随机数，否则后续Dropout、初始化或采样会从不同位置继续序列。

### 11.2 DataLoader工作进程的种子来源与worker_init_fn

DataLoader工作进程（worker）是并行执行数据读取和预处理的子进程。多个worker若错误地继承或复用同一随机状态，可能产生重复的数据增强。多进程DataLoader为每个worker设置PyTorch种子，基本关系是`base_seed + worker_id`。worker中使用NumPy或Python random时，还要在`worker_init_fn`里根据PyTorch分配的worker种子初始化这些库：

```python
def seed_worker(worker_id):
    """用DataLoader分配的PyTorch worker种子初始化NumPy和Python随机源。"""
    worker_seed = torch.initial_seed() % (2**32)
    np.random.seed(worker_seed)
    random.seed(worker_seed)


loader_generator = torch.Generator()
loader_generator.manual_seed(2026)
```

阶段3-3构造DataLoader时会把`seed_worker`和`loader_generator`分别传给`worker_init_fn`与`generator`。Windows多进程采用spawn时，自定义Dataset、collate函数和worker初始化函数应定义在模块顶层，主入口放入`if __name__ == "__main__":`保护。

### 11.3 确定性算法的适用范围与性能代价

确定性算法（deterministic algorithm）表示在规定的软件、硬件和输入条件相同时，多次执行会选择可重复的计算路径并产生一致结果。这一配置主要用于**复现错误和进行回归测试**。`torch.use_deterministic_algorithms(True)`要求算子在可用时选择确定性实现；操作没有确定性实现且当前配置要求报错时，程序会明确失败。CuDNN相关选择还受后端配置影响。

确定性实现可能降低速度、增加显存或禁用更快算法。开发阶段可用它复现问题和做回归测试，性能测量则应记录是否开启确定性配置。

PyTorch官方明确说明：跨版本、跨平台以及CPU与GPU之间不保证完全复现。实际可复现目标应写成“相同代码、依赖版本、设备和确定性设置下得到一致结果”。[PyTorch可复现性说明](https://docs.pytorch.org/docs/stable/notes/randomness.html)

## 12 PyTorch分组API微型实验

这一部分用六个独立程序把前面API的关键差异变成可观察结果，主要验证共享与复制、梯度状态、模块注册、shape衔接、损失契约和检查点恢复。下面六个实验彼此独立。Linux环境安装依赖：

```bash
python3 -m pip install torch numpy
```

Windows PowerShell可把运行命令中的`python3`替换为`python`。

### 12.1 Tensor复制共享、视图变形与连续性实验

本实验验证第1、2节的四个关系：`torch.tensor`复制、`from_numpy`共享、`permute`产生非连续视图，以及`contiguous`复制成连续存储。`data_ptr()`返回Tensor存储中首元素的地址，只用于比较本次进程中的存储关系。

```python
# tensor_storage_demo.py
import numpy as np
import torch


# source拥有2×3×4个float32元素，初始值为0到23。
source = np.arange(24, dtype=np.float32).reshape(2, 3, 4)

# copied分配新存储；shared与source共享CPU内存。
copied = torch.tensor(source)
shared = torch.from_numpy(source)

source[0, 0, 0] = 99.0
print("source修改后 copied[0,0,0]:", copied[0, 0, 0].item())
print("source修改后 shared[0,0,0]:", shared[0, 0, 0].item())

# permuted把(2,3,4)解释为(2,4,3)，只改变shape和stride。
permuted = shared.permute(0, 2, 1)
print("permuted shape:", tuple(permuted.shape))
print("permuted stride:", permuted.stride())
print("permuted contiguous:", permuted.is_contiguous())

try:
    # 最后两维的stride不满足合并条件，view不能只靠改元数据完成。
    invalid_view = permuted.view(2, 12)
    print("unexpected view shape:", tuple(invalid_view.shape))
except RuntimeError as error:
    print("view failed:", error)

# reshape允许在无法创建视图时复制；contiguous显式表达复制意图。
reshaped = permuted.reshape(2, 12)
compact = permuted.contiguous()
valid_view = compact.view(2, 12)

print("reshape shape:", tuple(reshaped.shape))
print("compact contiguous:", compact.is_contiguous())
print("permuted data_ptr:", permuted.data_ptr())
print("compact data_ptr:", compact.data_ptr())
print("valid view shares compact:", valid_view.data_ptr() == compact.data_ptr())
```

运行：

```bash
python3 tensor_storage_demo.py
```

`copied`首元素仍为0，`shared`首元素变为99。`permuted`不连续，`view`应报stride相关错误；`compact`使用新地址，`valid_view`与`compact`共享地址。

### 12.2 梯度累加、detach与推理模式实验

本实验只使用一个标量叶子Tensor。每次`parameter ** 2`都会创建一张新计算图，所以可以分别反向并观察`.grad`累加。

```python
# autograd_modes_demo.py
import torch


parameter = torch.tensor(2.0, requires_grad=True)

# 第一次反向：d(parameter²)/d(parameter)=2×2=4。
first_loss = parameter**2
first_loss.backward()
print("grad after first backward:", parameter.grad.item())

# 第二张新图再次贡献4，PyTorch把它累加到现有grad，结果为8。
second_loss = parameter**2
second_loss.backward()
print("grad after second backward:", parameter.grad.item())

# set_to_none语义可直接在参数层面观察：None表示当前没有梯度Tensor。
parameter.grad = None
print("grad after clear:", parameter.grad)

detached = parameter.detach()
print("detach requires_grad:", detached.requires_grad)
print("detach shares storage:", detached.data_ptr() == parameter.data_ptr())

with torch.no_grad():
    no_grad_result = parameter * 3
print("no_grad result requires_grad:", no_grad_result.requires_grad)

with torch.inference_mode():
    inference_result = parameter * 4
print("inference result requires_grad:", inference_result.requires_grad)

try:
    # 该结果没有grad_fn，调用backward无法回到parameter。
    no_grad_result.backward()
except RuntimeError as error:
    print("backward on no_grad result failed:", error)
```

运行：

```bash
python3 autograd_modes_demo.py
```

前两次梯度应为4和8，清理后为`None`。detach结果与原参数共享地址，但`requires_grad=False`；两个推理上下文的结果都没有梯度关系。

### 12.3 模块注册、ModuleList与state_dict实验

本实验创建两个结构相近的模块。普通Python列表可以保存层并在`forward()`中调用，但`nn.Module`不会递归注册列表内容；`ModuleList`会注册其中每一层。

```python
# module_registration_demo.py
import torch
from torch import nn


class PlainListModel(nn.Module):
    """保存两个可调用Linear层，但故意使用普通list演示漏注册。"""

    def __init__(self) -> None:
        super().__init__()
        self.layers = [nn.Linear(4, 4), nn.Linear(4, 2)]

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        """依次调用列表中的层；数值前向能运行，模型状态却不包含这些层。"""
        for layer in self.layers:
            inputs = layer(inputs)
        return inputs


class RegisteredListModel(nn.Module):
    """使用ModuleList注册相同的两层，调用顺序仍由forward控制。"""

    def __init__(self) -> None:
        super().__init__()
        self.layers = nn.ModuleList([nn.Linear(4, 4), nn.Linear(4, 2)])
        self.register_buffer("input_scale", torch.tensor(0.5))

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        """先应用持久缩放buffer，再依次调用已注册层。"""
        inputs = inputs * self.input_scale
        for layer in self.layers:
            inputs = layer(inputs)
        return inputs


plain = PlainListModel()
registered = RegisteredListModel()
sample = torch.ones(1, 4)

print("plain output shape:", tuple(plain(sample).shape))
print("registered output shape:", tuple(registered(sample).shape))
print("plain parameter count:", sum(p.numel() for p in plain.parameters()))
print("registered parameter count:", sum(p.numel() for p in registered.parameters()))
print("plain state keys:", list(plain.state_dict().keys()))
print("registered state keys:", list(registered.state_dict().keys()))
print("registered buffers:", list(dict(registered.named_buffers()).keys()))
```

运行：

```bash
python3 module_registration_demo.py
```

两个前向都能得到`(1,2)`输出。`plain`的参数数和state_dict键为空；`registered`包含两层权重、偏置及`input_scale`缓冲区。这说明“前向能执行”和“层已被模型管理”是两个独立条件。

### 12.4 常用神经网络层的逐层shape衔接实验

输入固定为`(2,3,32,32)`。卷积保持32×32，池化降到16×16，自适应池化固定为1×1，Flatten得到8个特征，最后Linear输出4个logits。

```python
# layer_shape_demo.py
import torch
from torch import nn


class ShapeNetwork(nn.Module):
    """演示卷积到分类头的shape链。

    classifier_features决定Linear期望的输入特征数；
    正确值为8，其他值用于稳定复现矩阵shape错误。
    """

    def __init__(self, classifier_features: int) -> None:
        super().__init__()
        self.conv = nn.Conv2d(3, 8, kernel_size=3, padding=1)
        self.norm = nn.BatchNorm2d(8)
        self.activation = nn.SiLU()
        self.pool = nn.MaxPool2d(kernel_size=2, stride=2)
        self.adaptive_pool = nn.AdaptiveAvgPool2d((1, 1))
        self.flatten = nn.Flatten(start_dim=1)
        self.classifier = nn.Linear(classifier_features, 4)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        """接收(N,3,32,32)，打印每一步shape并返回(N,4) logits。"""
        print("input:", tuple(inputs.shape))
        features = self.conv(inputs)
        print("conv:", tuple(features.shape))
        features = self.norm(features)
        features = self.activation(features)
        features = self.pool(features)
        print("max pool:", tuple(features.shape))
        features = self.adaptive_pool(features)
        print("adaptive pool:", tuple(features.shape))
        features = self.flatten(features)
        print("flatten:", tuple(features.shape))
        return self.classifier(features)


torch.manual_seed(7)
inputs = torch.randn(2, 3, 32, 32)

correct_model = ShapeNetwork(classifier_features=8)
logits = correct_model(inputs)
print("logits:", tuple(logits.shape))

try:
    # Flatten实际输出8个特征，错误分类头却要求16个，矩阵乘法会拒绝输入。
    wrong_model = ShapeNetwork(classifier_features=16)
    wrong_model(inputs)
except RuntimeError as error:
    print("wrong Linear failed:", error)
```

运行：

```bash
python3 layer_shape_demo.py
```

正确路径的shape依次为`(2,3,32,32)`、`(2,8,32,32)`、`(2,8,16,16)`、`(2,8,1,1)`、`(2,8)`和`(2,4)`。错误Linear会报告矩阵shape无法相乘，根因是构造参数`in_features=16`与Flatten输出8不一致。

### 12.5 损失reduction、标签dtype与类别权重实验

本实验使用三个样本、三个类别。第三个target是`ignore_index=-100`。类别2的权重设为2，因此第二个有效样本的损失贡献会被放大。

```python
# loss_contract_demo.py
import torch
from torch import nn


logits = torch.tensor(
    [
        [2.0, 1.0, 0.0],
        [0.2, 0.3, 1.5],
        [0.1, 0.1, 0.1],
    ],
    dtype=torch.float32,
)
targets = torch.tensor([0, 2, -100], dtype=torch.long)
class_weight = torch.tensor([1.0, 1.0, 2.0], dtype=torch.float32)

loss_none = nn.CrossEntropyLoss(
    weight=class_weight,
    ignore_index=-100,
    reduction="none",
)(logits, targets)
loss_sum = nn.CrossEntropyLoss(
    weight=class_weight,
    ignore_index=-100,
    reduction="sum",
)(logits, targets)
loss_mean = nn.CrossEntropyLoss(
    weight=class_weight,
    ignore_index=-100,
    reduction="mean",
)(logits, targets)

print("loss none:", loss_none)
print("loss sum:", loss_sum.item())
print("loss mean:", loss_mean.item())
print("sum of none:", loss_none.sum().item())

# mean的分母是有效target对应的类别权重之和：weight[0] + weight[2] = 3。
manual_weighted_mean = loss_none.sum() / (
    class_weight[targets[0]] + class_weight[targets[1]]
)
print("manual weighted mean:", manual_weighted_mean.item())

try:
    # 类别索引模式要求long；浮点target会被拒绝。
    invalid_targets = torch.tensor([0.0, 2.0, 1.0])
    nn.CrossEntropyLoss()(logits, invalid_targets)
except RuntimeError as error:
    print("float class indices failed:", error)
```

运行：

```bash
python3 loss_contract_demo.py
```

`loss_none`的第三项应为0，`loss_sum`等于`loss_none.sum()`。`loss_mean`应与手工按有效类别权重之和计算的结果一致。浮点类别索引会触发target dtype错误。

### 12.6 梯度累积、优化器参数组与检查点往返实验

本实验用两个单样本微批次完成一次更新。模型包含backbone与head两个参数组，学习率分别为0.1和0.2。每个微批次损失除以2，使两次反向累积得到两个样本平均损失的梯度。

```python
# optimizer_checkpoint_demo.py
from pathlib import Path

import torch
from torch import nn


class TinyRegressor(nn.Module):
    """两层无偏置回归模型。

    输入shape为(N,2)，backbone输出(N,2)，head输出(N,1)。
    """

    def __init__(self) -> None:
        super().__init__()
        self.backbone = nn.Linear(2, 2, bias=False)
        self.head = nn.Linear(2, 1, bias=False)

    def forward(self, inputs: torch.Tensor) -> torch.Tensor:
        """返回每个样本的一个连续预测值。"""
        return self.head(self.backbone(inputs))


def create_optimizer(model: TinyRegressor) -> torch.optim.Optimizer:
    """为两个子模块创建不同学习率的SGD参数组。

    返回的优化器持有model中已注册参数的引用，并为它们维护动量状态。
    """
    return torch.optim.SGD(
        [
            {"params": model.backbone.parameters(), "lr": 0.1},
            {"params": model.head.parameters(), "lr": 0.2},
        ],
        momentum=0.9,
    )


torch.manual_seed(7)
model = TinyRegressor()
optimizer = create_optimizer(model)
scheduler = torch.optim.lr_scheduler.StepLR(
    optimizer,
    step_size=1,
    gamma=0.1,
)
loss_function = nn.MSELoss()

micro_batches = [
    (torch.tensor([[1.0, 0.0]]), torch.tensor([[1.0]])),
    (torch.tensor([[0.0, 1.0]]), torch.tensor([[-1.0]])),
]

before_update = {
    name: parameter.detach().clone()
    for name, parameter in model.named_parameters()
}

optimizer.zero_grad(set_to_none=True)
for micro_index, (inputs, targets) in enumerate(micro_batches):
    predictions = model(inputs)

    # 两个等大小微批次各贡献总平均梯度的一半；第一次反向后不清零。
    scaled_loss = loss_function(predictions, targets) / len(micro_batches)
    scaled_loss.backward()
    print(
        f"head grad after micro batch {micro_index + 1}:",
        model.head.weight.grad.clone(),
    )

# 两次梯度已经累加，优化器此时只更新一次参数。
optimizer.step()
scheduler.step()

for name, parameter in model.named_parameters():
    changed = not torch.equal(before_update[name], parameter.detach())
    print(f"{name} changed:", changed)

print("optimizer state entries:", len(optimizer.state))
print("learning rates after scheduler:", [g["lr"] for g in optimizer.param_groups])

checkpoint_path = Path("api_checkpoint.pt")
checkpoint = {
    "epoch": 1,
    "model": model.state_dict(),
    "optimizer": optimizer.state_dict(),
    "scheduler": scheduler.state_dict(),
}
torch.save(checkpoint, checkpoint_path)

# 先创建新的模型、优化器和调度器，再把三个state_dict加载到对应对象。
restored_model = TinyRegressor()
restored_optimizer = create_optimizer(restored_model)
restored_scheduler = torch.optim.lr_scheduler.StepLR(
    restored_optimizer,
    step_size=1,
    gamma=0.1,
)
loaded = torch.load(
    checkpoint_path,
    map_location="cpu",
    weights_only=True,
)
load_result = restored_model.load_state_dict(loaded["model"], strict=True)
restored_optimizer.load_state_dict(loaded["optimizer"])
restored_scheduler.load_state_dict(loaded["scheduler"])

comparison_input = torch.tensor([[2.0, -1.0]])
with torch.inference_mode():
    original_output = model(comparison_input)
    restored_output = restored_model(comparison_input)

print("missing keys:", load_result.missing_keys)
print("unexpected keys:", load_result.unexpected_keys)
print("outputs equal:", torch.equal(original_output, restored_output))
print(
    "restored learning rates:",
    [group["lr"] for group in restored_optimizer.param_groups],
)
```

运行：

```bash
python3 optimizer_checkpoint_demo.py
```

第一次和第二次打印的head梯度不同，第二次包含两批贡献。全部参数应显示已经改变，SGD动量状态应包含参数条目，调度后两组学习率变为0.01和0.02。恢复结果的缺失键与多余键列表为空，原模型和恢复模型对固定输入的输出完全相同。程序会在当前目录留下`api_checkpoint.pt`，它可用于观察检查点字典结构。
