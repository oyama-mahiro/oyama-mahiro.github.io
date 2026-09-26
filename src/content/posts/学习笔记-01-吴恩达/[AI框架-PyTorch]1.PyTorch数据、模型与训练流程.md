---
title: '[AI框架-PyTorch] PyTorch数据、模型与训练流程'
published: 2026-09-22T08:26:00+08:00
description: '从直觉、公式与实际用法出发，介绍PyTorch数据、模型与训练流程的核心原理、常用方法与实践要点。'
tags: ['AI', 'PyTorch', '深度学习']
category: 'AI框架-PyTorch'
draft: false
lang: zh_CN
---

# [AI框架-PyTorch]1.PyTorch数据、模型与训练流程

学完前面的数学、机器学习和深度学习之后，我们已经知道模型训练在原理上做了什么：把一批数据送进模型，得到预测，用损失函数衡量预测与答案的差距，再通过反向传播计算梯度，最后由优化器修改参数。PyTorch 的作用，是把这套过程变成一组可以组合的程序接口。

这篇文章不再重新推导卷积、交叉熵、反向传播或 AdamW，而是回答一个更偏工程的问题：一份数据从磁盘进入程序以后，怎样变成张量，怎样按批次送进模型，模型怎样登记参数，训练、验证和推理分别调用哪些接口，最后又怎样保存训练结果。

文中代码沿用 `D:\AI_learn_project` 中已经出现过的 Fashion-MNIST、`Dataset`、`DataLoader`、自定义网络、GPU、ResNet 微调和模型保存等内容，并按照 2026 年 9 月的 PyTorch 官方接口重新核对。需要先纠正一个容易混淆的名称：PyTorch 自定义模型继承的是 **`torch.nn.Module`**，不是 `nn.Model`。

## 一、PyTorch 把训练过程拆成了哪些部分

可以把一套 PyTorch 程序看成一条生产线：

```text
原始数据
  ↓  Dataset：规定“第 i 个样本怎样读取”
单个样本
  ↓  DataLoader：打乱、分批、并行读取
一个 mini-batch
  ↓  nn.Module：执行前向计算
预测 logits
  ↓  损失函数：与标签比较
标量 loss
  ↓  loss.backward()：自动求梯度
参数的 .grad
  ↓  optimizer.step()：更新参数
新的模型参数
```

这条链上的对象各管一件事：

| 任务 | 常用接口 | 它实际负责什么 |
|---|---|---|
| 表示数据 | `torch.Tensor` | 保存数值、形状、数据类型和所在设备 |
| 定义单个样本 | `Dataset` | 给定索引，返回一条输入和它的标签 |
| 组织小批量 | `DataLoader` | 把多个样本堆成 batch，并负责打乱和加载 |
| 定义模型 | `nn.Module` | 登记子层和参数，规定输入怎样得到输出 |
| 衡量误差 | `nn.CrossEntropyLoss` 等 | 把预测和目标变成一个可优化的损失值 |
| 计算梯度 | `loss.backward()` | 沿当前计算图反向计算导数 |
| 更新参数 | `torch.optim` | 根据梯度和优化规则修改模型参数 |
| 切换阶段 | `model.train()`、`model.eval()` | 控制 Dropout、BatchNorm 等层的工作方式 |
| 关闭求导 | `torch.inference_mode()` | 验证和推理时停止记录反向传播信息 |
| 保存状态 | `state_dict()`、`torch.save()` | 保存模型参数或完整训练检查点 |

PyTorch 默认采用 **eager execution（即时执行）**：Python 运行到哪一行，张量运算通常就执行到哪一行。这样便于打印中间结果、检查形状和单步调试。需要提高性能时，还可以把已经能正确运行的模型交给 `torch.compile` 优化，但编译属于后续加速步骤，不应取代对基本训练流程的理解。

## 二、Tensor：模型、数据和梯度共同使用的容器

张量可以先理解为“带有形状和设备信息的多维数组”。一张灰度图片可以是二维张量，一批灰度图片通常是四维张量，神经网络的权重、输出和梯度也都用张量保存。

### 2.1 创建张量时要关注四件事

```python
import torch

x = torch.tensor(
    [[1.0, 2.0, 3.0],
     [4.0, 5.0, 6.0]],
    dtype=torch.float32,
)

print(x.shape)   # torch.Size([2, 3])
print(x.dtype)   # torch.float32
print(x.device)  # cpu
```

这里的 `x.shape == [2, 3]` 表示有 2 行、3 列。若把每一行看成一个样本，那么它代表“2 个样本，每个样本有 3 个特征”。`dtype` 决定每个数怎样存储；神经网络参数和连续输入通常使用 `float32`，分类标签通常使用 `int64`，在 PyTorch 中显示为 `torch.long`。`device` 表示张量位于 CPU、CUDA GPU 或其他加速设备上。

几个常用创建接口如下：

```python
zeros = torch.zeros(2, 3)       # 全零张量
ones = torch.ones(2, 3)         # 全一张量
noise = torch.randn(2, 3)       # 标准正态分布随机数
index = torch.arange(0, 6)      # 0, 1, 2, 3, 4, 5
image = torch.rand(8, 3, 224, 224)
```

最后一个张量采用本系列一直使用的 batch-first 记法：

$$
X\in\mathbb{R}^{B\times C\times H\times W}
=\mathbb{R}^{8\times3\times224\times224}.
$$

$B=8$ 表示一个批次有 8 张图，$C=3$ 表示 RGB 三个通道，$H=W=224$ 表示图像高和宽。模型能否运行，往往首先取决于这个形状是否符合层的输入约定。

### 2.2 改变形状不是随便改变数据

```python
x = torch.arange(24).reshape(2, 3, 4)

flat = x.reshape(2, 12)      # 保留批量维，把后两维铺平
swapped = x.permute(0, 2, 1) # [2, 3, 4] -> [2, 4, 3]
```

`reshape` 主要重新解释元素的排列方式。例如 `[2, 3, 4]` 中每个样本含有 $3\times4=12$ 个数，因此可以变成 `[2, 12]`。`permute` 则交换维度的顺序，它常用于把图像从 `[B,H,W,C]` 改成卷积层需要的 `[B,C,H,W]`。两者做的事情不同：一个重新分组，一个调整轴的次序。

矩阵乘法也依靠形状对接：

```python
features = torch.randn(32, 20)
weight = torch.randn(4, 20)
bias = torch.randn(4)

logits = features @ weight.T + bias
print(logits.shape)  # [32, 4]
```

`features` 表示 32 个样本、每个样本 20 个特征；`weight` 保存 4 个输出单元各自的 20 个权重。转置后执行 `[32,20] @ [20,4]`，得到 `[32,4]`：每个样本对应 4 个类别分数。这正是 `nn.Linear(20, 4)` 内部完成的仿射变换。

### 2.3 模型和数据必须位于同一设备

```python
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

model = model.to(device)
features = features.to(device)
labels = labels.to(device)
```

`to(device)` 返回位于目标设备上的张量，所以张量需要接住返回值；`nn.Module.to()` 会递归移动其中已经登记的参数和缓冲区。若模型在 GPU、输入还在 CPU，二者无法直接完成同一个矩阵运算。

## 三、数据从哪里来：四种常见入口

PyTorch 并不要求所有数据都用同一种方式获得。数据可能已经在内存里，也可能来自 torchvision 自带数据集、按类别分好的图片目录，或者业务自己的文件和数据库。无论来源怎样，最后都要能够按索引返回一个样本。

### 3.1 已经位于内存中的张量：`TensorDataset`

若特征和标签已经整理成张量，可以直接把它们按第一维配对：

```python
from torch.utils.data import TensorDataset

features = torch.randn(1000, 20)
labels = torch.randint(0, 4, (1000,))

dataset = TensorDataset(features, labels)
x0, y0 = dataset[0]
```

`features[0]` 与 `labels[0]` 会组成第 0 个样本。两个张量的第一维都必须是 1000，因为它们需要表示同一批对象。

### 3.2 官方公开数据集：`torchvision.datasets`

`torchvision.datasets` 封装了许多视觉数据集。以 Fashion-MNIST 为例：

```python
from torchvision import datasets, transforms

transform = transforms.Compose([
    transforms.ToTensor(),
    transforms.Normalize((0.5,), (0.5,)),
])

train_dataset = datasets.FashionMNIST(
    root="data",
    train=True,
    download=True,
    transform=transform,
)
```

几个参数分别表示：

- `root="data"`：把数据保存或读取到 `data` 目录；
- `train=True`：选择官方训练集，`False` 通常选择测试集；
- `download=True`：本地没有时下载到 `root`，已有时复用；
- `transform=transform`：每次取出图片时执行预处理。

`ToTensor()` 会把图片变成 `[C,H,W]` 张量，并把常见的 8 位像素缩放到 `[0,1]`。`Normalize((0.5,), (0.5,))` 再执行

$$
x_{\text{new}}=\frac{x-0.5}{0.5},
$$

使输入大致落到 `[-1,1]`。这里元组只有一个数，因为 Fashion-MNIST 是单通道灰度图。RGB 图像一般分别提供三个通道的均值和标准差。

### 3.3 按目录存放的图片：`ImageFolder`

若图片目录像下面这样按类别划分：

```text
images/
├─ cat/
│  ├─ 001.jpg
│  └─ 002.jpg
└─ dog/
   ├─ 001.jpg
   └─ 002.jpg
```

就可以使用：

```python
train_dataset = datasets.ImageFolder(
    root="images",
    transform=transform,
)

print(train_dataset.classes)      # ['cat', 'dog']
print(train_dataset.class_to_idx) # {'cat': 0, 'dog': 1}
```

`ImageFolder` 把每个一级子目录当作一个类别，并自动产生整数标签。它解决的是“目录结构已经规整”的情况；若一张图有多个标签，或者标签保存在 CSV、JSON 中，就需要自定义 `Dataset`。

### 3.4 自己的数据格式：继承 `Dataset`

自定义数据集最核心的接口只有三个：初始化时保存索引信息，`__len__` 返回样本数量，`__getitem__` 根据索引返回一条数据。

```python
from pathlib import Path
from torch.utils.data import Dataset
from torchvision.io import decode_image

class ImageTableDataset(Dataset):
    def __init__(self, rows, image_dir, transform=None):
        self.rows = rows
        self.image_dir = Path(image_dir)
        self.transform = transform

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        filename, label = self.rows[index]
        image = decode_image(str(self.image_dir / filename))

        if self.transform is not None:
            image = self.transform(image)

        return image, label
```

这里的 `rows[index]` 可以来自 CSV 解析结果，也可以来自数据库查询后生成的列表。若原始数据来自网络 API，一般先使用对应客户端或 HTTP 库获取数据，再解析成文件、数组或记录；PyTorch 的职责从 `Dataset` 开始，它不是通用的数据抓取工具。

## 四、`Dataset` 与 `DataLoader`：一个管样本，一个管批次

`Dataset` 回答“编号为 $i$ 的样本是什么”，`DataLoader` 回答“这次训练要拿哪些样本，并怎样把它们组成一批”。二者分开以后，模型训练不必关心图片究竟来自文件夹、压缩包还是内存。

```python
from torch.utils.data import DataLoader

train_loader = DataLoader(
    train_dataset,
    batch_size=64,
    shuffle=True,
    num_workers=0,
)

images, labels = next(iter(train_loader))
print(images.shape)  # [64, 1, 28, 28]
print(labels.shape)  # [64]
```

`batch_size=64` 表示尽量把 64 个样本堆叠成一批。由于单张 Fashion-MNIST 图片形状为 `[1,28,28]`，批量以后就在最前面增加样本维，得到 `[64,1,28,28]`。标签每个样本只有一个类别编号，因此是 `[64]`。

`shuffle=True` 会在每轮遍历时重新安排训练样本的读取顺序。验证集和测试集通常设为 `False`，因为它们不更新参数，固定顺序也更便于复现和对照。`num_workers` 决定用多少个子进程准备数据；它主要影响读取速度，不改变模型计算本身。

文本等变长数据不能直接堆叠时，可以传入 `collate_fn`，在组批时补齐序列或构造掩码：

```python
loader = DataLoader(
    dataset,
    batch_size=32,
    shuffle=True,
    collate_fn=make_batch,
)
```

`make_batch` 的输入是一组由 `Dataset` 返回的样本，输出则是模型真正需要的批量张量。它适合处理变长序列、目标检测中数量不同的边界框等情况。

官方教程把二者的分工概括得很清楚：`Dataset` 每次取一条特征和标签，`DataLoader` 负责 mini-batch、打乱和数据读取过程。[PyTorch Datasets 与 DataLoaders 教程](https://docs.pytorch.org/tutorials/beginner/basics/data_tutorial.html)

## 五、`nn.Module`：让 PyTorch 知道哪些对象属于模型

自定义模型通常继承 `nn.Module`。`__init__` 中创建并保存层，`forward` 中写数据流：

```python
from torch import nn

class Classifier(nn.Module):
    def __init__(self, input_dim, num_classes):
        super().__init__()

        self.network = nn.Sequential(
            nn.Linear(input_dim, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, num_classes),
        )

    def forward(self, x):
        return self.network(x)
```

`super().__init__()` 先初始化 `nn.Module` 的内部管理机制。随后把层保存为 `self.network`，PyTorch 才能把其中的权重和偏置登记为这个模型的参数。调用模型时写：

```python
model = Classifier(input_dim=784, num_classes=10)
x = torch.randn(32, 784)
logits = model(x)
```

推荐使用 `model(x)`，不要直接调用 `model.forward(x)`。`nn.Module.__call__` 会在合适的位置执行钩子、混合精度等框架行为，再进入 `forward`。

### 5.1 `Sequential`、普通子模块和 `ModuleList`

若网络只是依次执行若干层，`nn.Sequential` 最简洁：

```python
model = nn.Sequential(
    nn.Linear(20, 64),
    nn.ReLU(),
    nn.Linear(64, 4),
)
```

若存在残差连接、多个输入、条件分支或需要返回多个结果，就应编写自己的 `forward`。若需要用循环保存数量可变的层，要使用 `nn.ModuleList`：

```python
class RepeatedMLP(nn.Module):
    def __init__(self, width, depth):
        super().__init__()
        self.layers = nn.ModuleList([
            nn.Linear(width, width) for _ in range(depth)
        ])

    def forward(self, x):
        for layer in self.layers:
            x = torch.relu(layer(x))
        return x
```

普通 Python `list` 可以保存对象，却不会自动把里面的层登记为子模块；`ModuleList` 会让 `model.parameters()`、设备迁移和保存功能找到这些层。

### 5.2 参数与状态

```python
for name, parameter in model.named_parameters():
    print(name, parameter.shape)

state = model.state_dict()
```

`parameters()` 提供需要交给优化器的可训练参数。`named_parameters()` 额外给出名字，适合检查层和冻结参数。`state_dict()` 不只包含权重和偏置，还包含 BatchNorm 运行均值等已登记的持久缓冲区，因此它表示模型运行所需的状态，而不仅是“可训练参数列表”。[PyTorch `nn.Module` 文档](https://docs.pytorch.org/docs/main/generated/torch.nn.Module.html)

## 六、常用层、损失函数和优化器怎样配合

PyTorch 的 `torch.nn` 首先是一套神经网络积木。选层时要看输入数据的结构，选损失时要看任务输出和标签怎样表示。

| 任务或结构 | 常用模块 | 典型输入与输出 |
|---|---|---|
| 全连接映射 | `nn.Linear(d_in, d_out)` | `[B,d_in] → [B,d_out]` |
| 二维卷积 | `nn.Conv2d(C_in, C_out, kernel_size)` | `[B,C_in,H,W] → [B,C_out,H',W']` |
| 下采样 | `nn.MaxPool2d`、`nn.AvgPool2d` | 缩小空间尺寸 |
| 适应任意图片尺寸 | `nn.AdaptiveAvgPool2d` | 把空间尺寸变成指定大小 |
| 激活函数 | `nn.ReLU`、`nn.GELU`、`nn.SiLU` | 形状通常不变 |
| 随机失活 | `nn.Dropout(p)` | 训练时随机置零，推理时关闭 |
| 归一化 | `nn.BatchNorm2d`、`nn.LayerNorm` | 调整特征分布，形状通常不变 |
| 词向量查表 | `nn.Embedding(vocab, dim)` | token id `[B,T] → [B,T,dim]` |
| 循环网络 | `nn.RNN`、`nn.GRU`、`nn.LSTM` | 序列与隐藏状态 |
| 注意力 | `nn.MultiheadAttention` | Query、Key、Value → 注意力输出 |

常见任务与损失函数的对应关系是：

| 任务 | 模型最后输出 | 标签 | 常用损失 |
|---|---|---|---|
| 回归 | `[B]` 或 `[B,1]` 连续值 | 同形状连续值 | `nn.MSELoss()`、`nn.L1Loss()` |
| 单标签多分类 | `[B,K]` logits | `[B]` 整数类别 | `nn.CrossEntropyLoss()` |
| 二分类或多标签 | `[B]` 或 `[B,K]` logits | 同形状 0/1 浮点值 | `nn.BCEWithLogitsLoss()` |

以十分类为例：

```python
logits = model(images)          # [64, 10]
loss_fn = nn.CrossEntropyLoss()
loss = loss_fn(logits, labels)  # labels: [64]
```

`CrossEntropyLoss` 直接接收没有经过 Softmax 的 logits。它会在内部以数值稳定的方式组合 LogSoftmax 和负对数似然，因此训练前不要再手动执行 Softmax。

优化器负责“拿到梯度后怎样修改参数”：

```python
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=3e-4,
    weight_decay=1e-2,
)
```

`model.parameters()` 告诉优化器管理哪些张量，`lr` 是学习率，`weight_decay` 是解耦权重衰减。SGD、Adam 和 AdamW 的数学区别已经在《[AI进阶-深度学习]3.优化器、学习率与超参数调优.md》中展开；在 PyTorch 流程中，它们共享 `zero_grad()` 和 `step()` 这两个核心调用。

## 七、PyTorch 已经封装了哪些模型

这里要区分“通用模型部件”和“可以直接加载权重的完整模型”。`torch.nn` 主要提供层和参考结构，`torchvision.models` 则提供视觉任务的完整架构与预训练权重。

### 7.1 `torch.nn` 中的模型部件

- MLP 和卷积网络通常由 `Linear`、`Conv2d`、归一化、激活和池化层组合；
- 序列模型可直接使用 `RNN`、`GRU` 和 `LSTM`；
- Transformer 可使用 `MultiheadAttention`、`TransformerEncoderLayer`、`TransformerEncoder`、`TransformerDecoderLayer` 和 `TransformerDecoder`；
- 完整编码器—解码器参考结构可使用 `nn.Transformer`。

例如一个批量优先的 Transformer 编码层：

```python
encoder_layer = nn.TransformerEncoderLayer(
    d_model=256,
    nhead=8,
    dim_feedforward=1024,
    batch_first=True,
)

encoder = nn.TransformerEncoder(
    encoder_layer,
    num_layers=6,
)

x = torch.randn(32, 100, 256)
encoded = encoder(x)  # [32, 100, 256]
```

这段接口中的 `d_model=256` 是每个 token 的特征长度，`nhead=8` 表示 8 个注意力头，`batch_first=True` 让输入使用 `[B,T,D]`。官方把 `TransformerEncoderLayer` 定位为原始 Transformer 架构的参考实现，并明确说明它的功能相对现代 Transformer 架构较有限。因此学习结构或搭建普通注意力网络时可以直接使用；构建现代大语言模型时，通常还会使用更高层生态库或专门实现。[PyTorch `TransformerEncoderLayer` 文档](https://docs.pytorch.org/docs/stable/generated/torch.nn.TransformerEncoderLayer.html)

### 7.2 `torchvision.models` 中的视觉模型

TorchVision 提供多个任务的模型族：

- 图像分类：ResNet、DenseNet、EfficientNet、MobileNet、ConvNeXt、Vision Transformer、Swin Transformer 等；
- 目标检测：Faster R-CNN、RetinaNet、FCOS、SSD 等；
- 实例分割：Mask R-CNN；
- 语义分割：FCN、DeepLabV3、LRASPP；
- 关键点检测、视频分类和光流估计等模型。

当前加载预训练模型应使用 weights 枚举，而不是旧式 `pretrained=True`：

```python
from torchvision.models import resnet18, ResNet18_Weights

weights = ResNet18_Weights.DEFAULT
model = resnet18(weights=weights)
preprocess = weights.transforms()
```

`weights.transforms()` 会返回与这份权重匹配的缩放、裁剪和标准化操作。预训练权重并不只是一组参数，它还隐含了训练时的输入处理约定；图像尺寸、颜色范围或标准化不匹配，模型即使能运行，结果也可能明显变差。

把 ImageNet 的 1000 分类 ResNet-18 改成自己的 2 分类模型时，只需要替换最后的分类层：

```python
model.fc = nn.Linear(model.fc.in_features, 2)
```

若只想训练新分类头，可以先冻结主体：

```python
for parameter in model.parameters():
    parameter.requires_grad = False

model.fc = nn.Linear(model.fc.in_features, 2)
optimizer = torch.optim.AdamW(model.fc.parameters(), lr=1e-3)
```

TorchVision 还提供按名称查询和创建模型的接口：

```python
from torchvision.models import get_model, list_models

names = list_models(include="*resnet*")
model = get_model("resnet18", weights="DEFAULT")
```

官方模型列表和权重用法见 [TorchVision Models and Pre-trained Weights](https://docs.pytorch.org/vision/main/models)。BERT、GPT 等自然语言模型通常由 Hugging Face Transformers 等生态库提供，它们底层可以使用 PyTorch，但不能因此说 BERT 是 `torch.nn` 自带模型。

## 八、自动求导：`backward()` 到底留下了什么

PyTorch 会记录参与求导的张量运算，形成动态计算图。一个很小的例子是：

```python
w = torch.tensor(2.0, requires_grad=True)
x = torch.tensor(3.0)

y = (w * x - 1) ** 2
y.backward()

print(y.item())  # 25.0
print(w.grad)    # 30.0
```

这里

$$
y=(wx-1)^2=(2\times3-1)^2=25.
$$

对 $w$ 求导得到

$$
\frac{\partial y}{\partial w}
=2(wx-1)x
=2\times5\times3
=30.
$$

`y.backward()` 没有直接修改 $w$，而是把导数 30 写入 `w.grad`。神经网络训练也是同一件事，只是参数从一个标量变成了很多权重张量，计算图也更大。

`nn.Parameter` 默认需要梯度，所以模型层中的权重通常无需手动设置 `requires_grad=True`。需要注意的是，梯度默认会累加：连续两次调用 `backward()`，第二次梯度会加到原有 `.grad` 上。因此常规训练每轮都要调用：

```python
optimizer.zero_grad(set_to_none=True)
```

反向传播的链式法则和梯度流已经在《[AI进阶-深度学习]1.神经网络、前向传播与反向传播.md》中主讲。这里最需要记住的是接口分工：`backward()` 负责计算并累积梯度，`optimizer.step()` 才真正修改参数。

## 九、训练循环：五个核心动作不能混淆

一个训练 batch 的核心代码只有几行：

```python
model.train()

for images, labels in train_loader:
    images = images.to(device)
    labels = labels.to(device)

    optimizer.zero_grad(set_to_none=True)
    logits = model(images)
    loss = loss_fn(logits, labels)
    loss.backward()
    optimizer.step()
```

每一步的职责如下。

1. `model.train()` 把模型切换到训练模式。Dropout 会随机丢弃部分激活，BatchNorm 会使用当前 batch 的统计量并更新运行统计。
2. `optimizer.zero_grad()` 清理上一轮累积的参数梯度。
3. `logits = model(images)` 执行前向传播，同时为求导记录必要操作。
4. `loss.backward()` 从标量损失出发计算所有相关参数的梯度。
5. `optimizer.step()` 根据当前 `.grad` 更新参数。

顺序不能随意交换。若先 `step()` 再 `backward()`，优化器还没有本轮梯度可用；若长期不清梯度，多个 batch 的梯度会相加，等价于改变了训练算法。

统计整轮平均损失时，要按样本数加权：

```python
loss_sum = 0.0
sample_count = 0

for images, labels in train_loader:
    # 前向、反向和更新省略
    batch_size = labels.size(0)
    loss_sum += loss.item() * batch_size
    sample_count += batch_size

mean_loss = loss_sum / sample_count
```

这是因为 `CrossEntropyLoss` 默认返回当前 batch 的平均损失。最后一批可能不足设定的 `batch_size`，直接平均各批的 loss 会让小批次获得和大批次相同的权重。

## 十、验证与推理：既要切换模式，也要关闭求导

验证集用于训练过程中比较模型版本、选择超参数或决定何时停止；测试集用于最终报告泛化结果。二者都不更新参数，但仍然要运行模型。

```python
model.eval()

correct = 0
sample_count = 0

with torch.inference_mode():
    for images, labels in val_loader:
        images = images.to(device)
        labels = labels.to(device)

        logits = model(images)
        predictions = logits.argmax(dim=1)

        correct += (predictions == labels).sum().item()
        sample_count += labels.size(0)

accuracy = correct / sample_count
```

`model.eval()` 和 `torch.inference_mode()` 解决的是两件不同的事：

- `eval()` 改变部分层的行为，例如关闭 Dropout，并让 BatchNorm 使用训练阶段积累的运行统计；
- `inference_mode()` 关闭自动求导记录，减少验证和推理的时间、显存开销。

`inference_mode()` 不会自动执行 `eval()`，因此正式验证和推理通常同时使用二者。验证结束后，下一轮训练还要再次调用 `model.train()`。

单个分类结果通常由最大 logit 的索引得到：

```python
model.eval()

with torch.inference_mode():
    logits = model(image.unsqueeze(0).to(device))
    probability = logits.softmax(dim=1)
    predicted_class = probability.argmax(dim=1)
```

假设输出为 `[1,10]`，`softmax(dim=1)` 在 10 个类别上归一化。训练损失需要原始 logits，只有在展示概率、阈值判断或需要概率含义时才计算 Softmax。

## 十一、保存模型：部署参数与继续训练是两种需求

### 11.1 只保存模型参数

若目标是以后加载模型进行推理，通常保存 `state_dict`：

```python
torch.save(model.state_dict(), "fashion_cnn_weights.pt")
```

加载时先构造相同结构，再填入参数：

```python
model = FashionCNN(num_classes=10)

state = torch.load(
    "fashion_cnn_weights.pt",
    map_location=device,
    weights_only=True,
)

model.load_state_dict(state)
model.to(device)
model.eval()
```

只保存 `state_dict` 的好处是模型结构仍然由清晰的 Python 代码定义，参数文件也更容易跨环境管理。PyTorch 官方教程仍把保存 `state_dict` 作为常见推荐做法。[PyTorch Saving and Loading Models](https://docs.pytorch.org/tutorials/beginner/saving_loading_models.html)

### 11.2 保存可继续训练的检查点

若训练可能中断，除了模型参数，还要保留优化器状态、轮数和当前指标：

```python
checkpoint = {
    "epoch": epoch,
    "model_state_dict": model.state_dict(),
    "optimizer_state_dict": optimizer.state_dict(),
    "val_loss": val_loss,
}

torch.save(checkpoint, "checkpoint.pt")
```

恢复时：

```python
checkpoint = torch.load(
    "checkpoint.pt",
    map_location=device,
    weights_only=True,
)

model.load_state_dict(checkpoint["model_state_dict"])
optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
start_epoch = checkpoint["epoch"] + 1
```

AdamW 等优化器不仅保存当前参数，还维护动量和二阶矩估计。只恢复模型而不恢复优化器，虽然可以继续运行，但并不是从中断点严格续训。

## 十二、把数据、模型、训练和推理完整串起来

下面使用 Fashion-MNIST 完成一条可运行的十分类流程。代码只保留主线：获取数据、切分训练/验证集、构建加载器、定义 CNN、训练、验证、保存最佳参数、加载并推理。

### 12.1 完整代码

```python
from pathlib import Path

import torch
from torch import nn
from torch.utils.data import DataLoader, random_split
from torchvision import datasets, transforms


# 1. 运行设备
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# 2. 数据预处理与获取
transform = transforms.Compose([
    transforms.ToTensor(),
    transforms.Normalize((0.5,), (0.5,)),
])

full_train_dataset = datasets.FashionMNIST(
    root="data",
    train=True,
    download=True,
    transform=transform,
)

test_dataset = datasets.FashionMNIST(
    root="data",
    train=False,
    download=True,
    transform=transform,
)

train_dataset, val_dataset = random_split(
    full_train_dataset,
    lengths=[50_000, 10_000],
    generator=torch.Generator().manual_seed(42),
)


# 3. 小批量加载器
train_loader = DataLoader(
    train_dataset,
    batch_size=128,
    shuffle=True,
)

val_loader = DataLoader(
    val_dataset,
    batch_size=256,
    shuffle=False,
)

test_loader = DataLoader(
    test_dataset,
    batch_size=256,
    shuffle=False,
)


# 4. 模型
class FashionCNN(nn.Module):
    def __init__(self, num_classes=10):
        super().__init__()

        self.features = nn.Sequential(
            nn.Conv2d(1, 32, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(kernel_size=2),
            nn.Conv2d(32, 64, kernel_size=3, padding=1),
            nn.ReLU(),
            nn.MaxPool2d(kernel_size=2),
        )

        self.classifier = nn.Sequential(
            nn.Flatten(),
            nn.Linear(64 * 7 * 7, 128),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(128, num_classes),
        )

    def forward(self, x):
        x = self.features(x)
        return self.classifier(x)


model = FashionCNN().to(device)
loss_fn = nn.CrossEntropyLoss()
optimizer = torch.optim.AdamW(
    model.parameters(),
    lr=1e-3,
    weight_decay=1e-2,
)


# 5. 一轮训练
def train_one_epoch(model, data_loader, loss_fn, optimizer, device):
    model.train()

    loss_sum = 0.0
    correct = 0
    sample_count = 0

    for images, labels in data_loader:
        images = images.to(device)
        labels = labels.to(device)

        optimizer.zero_grad(set_to_none=True)

        logits = model(images)
        loss = loss_fn(logits, labels)

        loss.backward()
        optimizer.step()

        batch_size = labels.size(0)
        loss_sum += loss.item() * batch_size
        correct += (logits.argmax(dim=1) == labels).sum().item()
        sample_count += batch_size

    return loss_sum / sample_count, correct / sample_count


# 6. 验证或测试
@torch.inference_mode()
def evaluate(model, data_loader, loss_fn, device):
    model.eval()

    loss_sum = 0.0
    correct = 0
    sample_count = 0

    for images, labels in data_loader:
        images = images.to(device)
        labels = labels.to(device)

        logits = model(images)
        loss = loss_fn(logits, labels)

        batch_size = labels.size(0)
        loss_sum += loss.item() * batch_size
        correct += (logits.argmax(dim=1) == labels).sum().item()
        sample_count += batch_size

    return loss_sum / sample_count, correct / sample_count


# 7. 训练并保存验证集上最好的参数
weights_path = Path("fashion_cnn_weights.pt")
best_val_loss = float("inf")

for epoch in range(5):
    train_loss, train_accuracy = train_one_epoch(
        model,
        train_loader,
        loss_fn,
        optimizer,
        device,
    )

    val_loss, val_accuracy = evaluate(
        model,
        val_loader,
        loss_fn,
        device,
    )

    print(
        f"epoch={epoch + 1} "
        f"train_loss={train_loss:.4f} "
        f"train_acc={train_accuracy:.4f} "
        f"val_loss={val_loss:.4f} "
        f"val_acc={val_accuracy:.4f}"
    )

    if val_loss < best_val_loss:
        best_val_loss = val_loss
        torch.save(model.state_dict(), weights_path)


# 8. 加载最佳参数并在测试集评估
best_state = torch.load(
    weights_path,
    map_location=device,
    weights_only=True,
)

model.load_state_dict(best_state)

test_loss, test_accuracy = evaluate(
    model,
    test_loader,
    loss_fn,
    device,
)

print(f"test_loss={test_loss:.4f} test_acc={test_accuracy:.4f}")


# 9. 取一个 batch 做推理
images, labels = next(iter(test_loader))
images = images.to(device)

model.eval()
with torch.inference_mode():
    logits = model(images)
    probabilities = logits.softmax(dim=1)
    predictions = probabilities.argmax(dim=1)

print("前 10 个预测：", predictions[:10].cpu())
print("前 10 个标签：", labels[:10])
```

### 12.2 数据在模型中的形状变化

理解完整流程时，不应只看函数名，还要跟住张量形状。一个 batch 的输入为：

$$
[B,1,28,28].
$$

第一层 `Conv2d(1,32,3,padding=1)` 把通道数从 1 变成 32，因为 padding 保持高宽不变：

$$
[B,1,28,28]\rightarrow[B,32,28,28].
$$

`MaxPool2d(2)` 把每个 $2\times2$ 区域压缩为一个值：

$$
[B,32,28,28]\rightarrow[B,32,14,14].
$$

第二组卷积和池化继续得到：

$$
[B,32,14,14]
\rightarrow[B,64,14,14]
\rightarrow[B,64,7,7].
$$

`Flatten` 保留批量维，把其余维度铺平：

$$
[B,64,7,7]\rightarrow[B,64\times7\times7]=[B,3136].
$$

最后两个线性层产生十个类别的 logits：

$$
[B,3136]\rightarrow[B,128]\rightarrow[B,10].
$$

因此 `CrossEntropyLoss` 接收 `[B,10]` 的预测和 `[B]` 的整数标签。推理阶段的 `argmax(dim=1)` 则在每个样本自己的 10 个类别分数中选择最大值。

### 12.3 为什么用验证损失保存最佳模型

训练损失降低，只说明模型越来越适合训练样本。验证损失反映当前参数在未参与更新的数据上的表现，所以代码在 `val_loss` 创下新低时保存模型。训练结束后重新加载最佳验证参数，再运行一次测试集，避免把最后一个 epoch 自动当成最好结果。

这也把训练、验证和测试的职责分清了：训练集产生梯度，验证集帮助选择模型，测试集只在选择完成后衡量最终结果。若反复根据测试结果调结构或学习率，测试集实际上就参与了模型选择，最终指标会变得过于乐观。

## 十三、训练正确以后再考虑的性能接口

最先要保证的是数据、形状、损失和验证流程正确。在此基础上，PyTorch 还提供几个常用加速入口。

### 13.1 自动混合精度

在支持的 GPU 上，自动混合精度让部分运算使用更低精度以提高吞吐、减少显存，同时对容易出现数值问题的运算保留合适精度。训练时通常组合 `torch.autocast` 与 `torch.amp.GradScaler`：

```python
scaler = torch.amp.GradScaler("cuda")

for images, labels in train_loader:
    images = images.to(device)
    labels = labels.to(device)

    optimizer.zero_grad(set_to_none=True)

    with torch.autocast(device_type="cuda", dtype=torch.float16):
        logits = model(images)
        loss = loss_fn(logits, labels)

    scaler.scale(loss).backward()
    scaler.step(optimizer)
    scaler.update()
```

`autocast` 决定哪些运算用较低精度，`GradScaler` 放大损失以减少 float16 梯度下溢。推理只需要 `autocast`，不需要反向传播用的 `GradScaler`。[PyTorch Automatic Mixed Precision Recipe](https://docs.pytorch.org/tutorials/recipes/recipes/amp_recipe.html)

### 13.2 `torch.compile`

模型已经能正确运行后，可以尝试：

```python
model = torch.compile(model)
```

它会分析 PyTorch 运算并生成优化后的执行代码，PyTorch 2.0 之后成为主要编译入口。动态控制流或输入形状频繁变化可能触发重新编译或 graph break，因此它不是“任何代码都会固定加速”的开关，需要用真实工作负载测量。[PyTorch `torch.compile` 教程](https://docs.pytorch.org/tutorials/intermediate/torch_compile_tutorial)

### 13.3 多 GPU 训练

单机或多机多 GPU 的主流接口是 `DistributedDataParallel`（DDP）。它为每个进程维护一份模型副本，并在反向传播时同步梯度；数据通常配合 `DistributedSampler` 分给各进程。DDP 会改变程序启动、数据采样和指标汇总方式，适合在单卡流程已经正确且训练规模确实需要时再加入。

至此，PyTorch 的主线可以归结为一套稳定的对象关系：`Dataset` 定义样本，`DataLoader` 组成批次，`nn.Module` 把批次映射为预测，损失函数把预测压成一个标量，自动求导把标量变成参数梯度，优化器利用梯度修改参数；验证和推理沿用同一个模型，却切换到 `eval()` 并关闭求导；`state_dict` 最后把学习到的状态保存下来。这条主线一旦清楚，换成 ResNet、Transformer 或自己的网络，改变的主要是数据预处理、模型结构和任务损失，训练框架本身仍然相通。

