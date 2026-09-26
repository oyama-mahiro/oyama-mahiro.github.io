---
title: '[嵌入式AI-推理部署] ONNX导出、模型结构与合法性检查'
published: 2026-09-24T08:29:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍ONNX导出、模型结构与合法性检查的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-2 ONNX导出、模型结构与合法性检查

开放神经网络交换格式（Open Neural Network Exchange，ONNX）是一种用计算图保存模型结构、权重和输入输出约定的模型格式。ONNX 图中的节点、初始化器、属性和算子域已在阶段4-1第1节解释，本篇只解决一个更具体的问题：怎样把能够执行的 PyTorch 模型导出成 ONNX，并用少量关键检查确认这个文件可以继续交给目标推理后端。

完整过程如下：

```text
确认 .pt 文件中保存的内容
→ 恢复模型结构和参数
→ 切换到推理状态
→ 准备能够走通目标执行路径的样例输入
→ 按目标后端支持的算子集版本导出
→ 检查文件结构、输入输出和算子域
→ 发现问题后回到导出配置或 PyTorch 模型修改
```

这里的“检查通过”只说明 ONNX 文件符合 ONNX 自身的结构规则。目标 NPU 转换器、TensorRT 或其他推理后端还会检查自己支持的算子、数据类型和形状范围。数值结果是否与 PyTorch 足够接近，需要在阶段4-3中用 ONNX Runtime 建立数值基线。

## 1 从PyTorch模型文件导出ONNX的完整过程

### 1.1 `.pt`文件中的完整模型、参数字典与训练检查点

`.pt` 和 `.pth` 只是 PyTorch 常用的文件后缀，后缀无法说明文件内部保存了什么。同名后缀可以保存完整模型、参数字典、训练检查点，也可以保存某个框架自定义的检查点。导出前最可靠的判断依据是训练代码中的保存语句和加载后对象的类型。

PyTorch 官方保存与加载教程也把 `torch.save()`、`torch.load()` 和 `load_state_dict()` 作为三个核心接口，并分别给出了参数字典、完整模型和通用训练检查点的保存方式：[PyTorch模型保存与加载教程](https://docs.pytorch.org/tutorials/beginner/saving_loading_models.html)。

| `.pt` 中的内容 | 加载后对象 | 主要用途 | 导出前的处理 |
| --- | --- | --- | --- |
| 完整模型对象 | `nn.Module` | 在相同代码环境中快速恢复推理模型 | 确保原模型类能够导入，再调用 `eval()` |
| 仅模型参数 | `dict` 或 `OrderedDict` | 长期保存权重、跨项目加载、迁移训练 | 先创建模型结构，再调用 `load_state_dict()` |
| 训练检查点 | 包含多个字段的 `dict` | 中断后从原训练状态继续 | 恢复模型、优化器、轮次；导出时只取模型 |
| 框架封装的检查点 | 由框架解释的对象或字典 | 让框架统一处理训练、推理和导出 | 使用对应框架的加载与导出接口 |

下面分别说明四种内容保存了什么、适合什么场景，以及怎样保存和加载。

**1. 完整模型对象**

完整模型对象同时保存模型结构引用和当前参数。它适合模型类、项目目录和软件版本都由同一团队控制的短期实验，加载后可以直接得到具有 `forward()` 前向计算方法的 `nn.Module`：

```python
import torch
from torch import nn

from project_model import ImageClassifier


# ImageClassifier 的类定义位于 project_model.py。
model = ImageClassifier(num_classes=10)
torch.save(model, "full_model.pt")

# weights_only=False 允许恢复完整 Python 对象，因此文件必须来自可信来源。
# 加载时 Python 仍要能够从 project_model 找到 ImageClassifier。
loaded_model = torch.load(
    "full_model.pt",
    map_location="cpu",
    weights_only=False,
)
if not isinstance(loaded_model, nn.Module):
    raise TypeError(f"加载结果不是模型对象：{type(loaded_model).__name__}")
loaded_model.eval()
```

`torch.save(model, ...)` 会记录对象所属的类和模块路径，没有把该类的全部 Python 源码独立封装进 `.pt`。如果加载环境缺少 `project_model.py`、类名已经修改或模块路径发生变化，`torch.load()` 仍会失败。完整对象还使用 Python 反序列化，只能加载可信来源的文件。

**2. 仅模型参数**

`model.state_dict()` 返回“参数名称到张量”的字典，其中包括卷积权重、偏置以及批归一化层的运行统计量。它不包含模型层怎样连接，也没有 `forward()`。这种方式把结构代码和参数文件分开，适合长期维护、发布权重、迁移训练和部署导出。

```python
import torch

from project_model import ImageClassifier


source_model = ImageClassifier(num_classes=10)

# 保存 API：state_dict() 取出模型当前参数，torch.save() 写入磁盘。
torch.save(source_model.state_dict(), "model_weights.pt")

# 加载时先建立结构相同的空模型，再把参数装入对应名称。
loaded_model = ImageClassifier(num_classes=10)
state_dict = torch.load(
    "model_weights.pt",
    map_location="cpu",
    weights_only=True,
)
loaded_model.load_state_dict(state_dict, strict=True)
loaded_model.eval()
```

`strict=True` 要求文件中的参数名称与模型中的参数名称完全一致。类别数、层名称或通道数变化时，应先确认哪些层可以复用，再有意识地处理不匹配项。直接忽略缺失参数会让对应层保留随机初始值。

**3. 训练检查点**

训练检查点用于“从中断位置继续训练”。除了模型参数，它通常还保存优化器状态、当前轮次、学习率调度器状态和当前最优指标。以 Adam 优化器为例，优化器状态中包含每个参数的一阶、二阶动量；缺失这些状态时无法精确延续原来的更新过程。

```python
import torch

from project_model import ImageClassifier


model = ImageClassifier(num_classes=10)
optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)
current_epoch = 12
best_accuracy = 0.91

# 保存 API：把恢复训练需要的状态放入同一个字典。
torch.save(
    {
        "epoch": current_epoch,
        "model_state_dict": model.state_dict(),
        "optimizer_state_dict": optimizer.state_dict(),
        "best_accuracy": best_accuracy,
    },
    "training_checkpoint.pt",
)

# 加载时先创建同结构模型和同类型优化器。
checkpoint = torch.load(
    "training_checkpoint.pt",
    map_location="cpu",
    weights_only=True,
)
resumed_model = ImageClassifier(num_classes=10)
resumed_optimizer = torch.optim.Adam(resumed_model.parameters(), lr=1e-3)

resumed_model.load_state_dict(checkpoint["model_state_dict"])
resumed_optimizer.load_state_dict(checkpoint["optimizer_state_dict"])
start_epoch = checkpoint["epoch"] + 1
best_accuracy = checkpoint["best_accuracy"]
```

这里的 `start_epoch` 为 13，下一轮训练会沿用保存时的模型参数和优化器内部状态。如果只有 `model_weights.pt`，仍然可以继续训练：创建新优化器后加载模型参数即可。此时优化器的动量等状态从初始值开始，训练轮次和学习率也要重新设置，这属于以已有权重为起点的新训练或迁移训练，无法严格复现原训练在下一步会执行的参数更新。

导出 ONNX 时不需要恢复优化器。只取 `model_state_dict` 装入模型并调用 `eval()`；`epoch`、优化器状态和训练指标不会进入推理图。

**4. 框架封装的检查点**

Ultralytics 等框架会在普通 PyTorch 保存内容之外记录任务类型、模型配置、类别名称和训练状态，并提供统一加载入口。此类文件应交给生成它的框架解释。Ultralytics 训练会在运行目录的 `weights` 文件夹保存 `best.pt` 和 `last.pt`；`best.pt` 用于保存验证指标最好的权重，`last.pt` 还适合恢复最近一次训练。

```python
from ultralytics import YOLO


# 框架加载 API：YOLO() 读取检查点并恢复任务类型、模型结构和参数。
yolo_model = YOLO("runs/detect/train/weights/best.pt")

# 加载后可以直接推理，也可以调用框架自己的导出接口。
results = yolo_model.predict("bus.jpg")
onnx_path = yolo_model.export(
    format="onnx",
    imgsz=640,
    simplify=False,
)
print(f"ONNX文件：{onnx_path}")
```

要从 Ultralytics 的最近训练状态继续，加载 `last.pt` 后调用 `train(resume=True)`。当前官方训练文档说明，恢复训练会加载模型权重、优化器状态、学习率调度状态和轮次：[Ultralytics恢复训练说明](https://docs.ultralytics.com/modes/train/#resuming-interrupted-trainings)。只想用现有权重训练新数据时，加载 `best.pt` 后正常调用 `train(data=..., epochs=...)`，框架会建立新的训练过程。

### 1.2 样例输入的形状、数据类型、设备与执行路径

`torch.onnx.export()` 需要一组样例输入来执行或捕获模型的前向路径。样例输入同时提供以下信息：

- 输入数量和容器结构，例如一个张量或由两个张量组成的元组。
- 每个输入的秩、各维长度和数据类型。
- 输入所在设备。模型参数和输入必须位于同一设备。
- 当前输入会触发的执行路径。

图像模型常见输入为 NCHW 布局，即 `[批量, 通道, 高, 宽]`。以单张 640×640 的三通道 32 位浮点图像为例：

```python
# 模型和样例输入都在 CPU；形状为 [1, 3, 640, 640]，数据类型为 float32。
example_images = torch.randn(
    1,
    3,
    640,
    640,
    dtype=torch.float32,
    device="cpu",
)
```

样例值不需要来自真实图片，但形状、数据类型和设备必须满足模型输入要求。如果 `forward()` 中存在由张量数值控制的 Python 分支，单组样例只能走其中一条路径；未被捕获的分支不会自动出现在 ONNX 图中。部署前应尽量把这种数据相关控制流改写成导出器和目标后端明确支持的张量运算。

### 1.3 `torch.onnx.export()`的调用方法与核心参数

`torch.onnx.export()` 是 PyTorch 提供的 ONNX 导出函数。当前官方文档推荐使用基于 `torch.export` 的导出路径，并将 `dynamo=True` 作为默认值；`dynamic_shapes` 用于声明哪些输入维度在运行时可变：[PyTorch ONNX 文档](https://docs.pytorch.org/docs/stable/onnx.html)。

下面先导出固定形状模型：

```python
import torch


# model 已按 1.1 节恢复为可执行对象并调用 eval()。
# example_images 已按 1.2 节创建，形状为 [1, 3, 640, 640]。
torch.onnx.export(
    model=model,                         # 需要捕获其前向计算的 PyTorch 模型
    args=(example_images,),              # forward() 的位置参数；单输入也写成一项元组
    f="model_static.onnx",               # 成功后写出的 ONNX 文件
    input_names=["images"],              # 给图输入设置稳定名称，方便后续推理代码绑定
    output_names=["predictions"],        # 名称数量必须与模型实际输出数量一致
    opset_version=17,                    # 示例假定目标后端明确支持 ONNX 算子集 17
    dynamo=True,                         # 使用当前推荐的导出路径
)
```

最需要理解的参数有：

- `model`：已经恢复参数并切到推理状态的模型对象。
- `args`：传给 `forward()` 的位置参数。模型还有关键字参数时，可使用 `kwargs`。
- `f`：输出文件路径。
- `input_names` 和 `output_names`：图接口名称。它们只改名称，不会改变张量形状和计算。
- `opset_version`：导出图采用的 ONNX 算子集版本。该版本必须落在目标后端支持范围内。
- `dynamo`：选择当前基于 `torch.export` 的导出器。
- `dynamic_shapes`：声明动态维度，下一节单独说明。

导出函数成功返回只代表文件已经生成。仍需执行第2节的检查。

### 1.4 静态形状与动态维度的导出配置

固定形状导出会把样例输入中的 `1×3×640×640` 记录为图输入约定。之后给该模型输入 `1×3×480×640`，支持严格静态形状的后端会直接拒绝，或者在编译模型时只能选择 640×640。

动态维度需要在导出时显式声明。下面把批量、高度和宽度声明为动态维度，通道数仍固定为 3：

```python
import torch


# Dim 为动态维度建立符号名称。相同符号可用于表达两个位置长度相等。
batch_dim = torch.export.Dim("batch")
height_dim = torch.export.Dim("height")
width_dim = torch.export.Dim("width")

torch.onnx.export(
    model=model,
    args=(example_images,),
    f="model_dynamic.onnx",
    input_names=["images"],
    output_names=["predictions"],
    opset_version=17,
    dynamo=True,
    # 该元组与 args 的结构一一对应。
    # 第一个字典中的键 0、2、3 分别代表输入的批量、高度、宽度轴。
    dynamic_shapes=(
        {
            0: batch_dim,
            2: height_dim,
            3: width_dim,
        },
    ),
)
```

动态声明只表示这些长度由运行时输入确定。模型内部的步长、拼接、形状变换和目标后端仍会限制合法尺寸。例如 YOLO11 检测模型的主干会多次下采样，部署端通常还会把输入高宽补到模型步长的整数倍。目标 NPU 只接受固定尺寸时，导出动态 ONNX 也无法让该 NPU 获得任意尺寸能力。

旧项目使用传统导出器时会看到 `dynamic_axes`。维护旧代码时应先确认 `dynamo` 的取值；新代码优先按当前 PyTorch 文档使用 `dynamo=True` 和 `dynamic_shapes`，避免把两套参数的规则混在一起。

### 1.5 算子集版本与软件版本的选择方法

算子集版本（opset version）决定图中各标准 ONNX 算子的定义版本。ONNX 模型通过 `opset_import` 记录自己使用的算子域和版本；同名算子在不同版本中可以增加输入、属性或数据类型支持：[ONNX 版本说明](https://onnx.ai/onnx/repo-docs/Versioning.html)。

版本选择按下面的顺序进行：

1. 查看最终目标后端的官方支持表，确认它支持的 ONNX 算子集范围和限制。
2. 在这个范围内选择 PyTorch 导出器能够生成、模型也能成功导出的版本。
3. 使用该版本完成导出和检查，再交给目标后端转换。
4. 如果后端报告某个算子不支持，检查该算子的类型、版本和属性；修改模型或降低导出版本后重新导出。

直接把模型文件里的版本号从 17 改成 13，不会重写节点。若两个版本对某个算子的输入和属性定义不同，修改数字会让图声明与节点实际内容不一致。正确做法是重新调用导出器生成目标版本。

软件版本也应随模型一起记录，至少包括 Python、PyTorch、ONNX、Ultralytics 和目标转换器版本。导出接口、图改写规则和后端支持表都会随版本变化。同一份 `.pt` 在不同环境中导出出不同节点结构时，版本记录能帮助复现差异。

### 1.6 Ultralytics模型导出接口与普通PyTorch导出的区别

Ultralytics 是封装 YOLO 训练、验证、预测和导出的视觉模型框架。它的 `YOLO("yolo11n.pt")` 会按框架自己的检查点格式恢复模型，`model.export(format="onnx")` 再完成样例输入准备、图导出和部分图处理。YOLO11 官方文档列出了 `yolo11n.pt` 的导出支持：[Ultralytics YOLO11 文档](https://docs.ultralytics.com/models/yolo11/)。

普通 PyTorch 导出要求开发者自己负责模型结构、参数加载、样例输入、输入输出名称和动态维度。Ultralytics 接口把这些步骤封装为 `imgsz`、`batch`、`dynamic`、`simplify`、`opset` 和 `device` 等参数。根据当前官方导出文档，`dynamic` 默认关闭，`simplify` 默认开启，`opset=None` 会选择当前软件支持的版本：[Ultralytics 导出参数](https://docs.ultralytics.com/modes/export/)。

建立部署基线时应显式填写关键参数。第4节先使用 `simplify=False` 保存未经额外简化的原始图，再单独导出动态版本。这样遇到结构或数值变化时，可以区分问题来自原始导出还是后续简化。

## 2 ONNX模型导出后的必要检查

### 2.1 ONNX文件加载与结构合法性检查

第一项检查只有两步：使用 `onnx.load()` 解析文件，再使用 `onnx.checker.check_model()` 检查 ONNX 结构和节点是否满足格式约束。官方接口说明中，`check_model()` 用于检查模型的一致性：[ONNX checker 文档](https://onnx.ai/onnx/api/checker.html)。

```python
from pathlib import Path

import onnx


model_path = Path("model_static.onnx")
if not model_path.is_file():
    raise FileNotFoundError(f"找不到待检查模型：{model_path.resolve()}")

# load() 负责把磁盘文件解析成内存中的 ModelProto 对象。
onnx_model = onnx.load(model_path)

# 检查失败时会抛出异常，脚本应停止，不应继续把该文件交给目标转换器。
onnx.checker.check_model(onnx_model)
print(f"ONNX结构检查通过：{model_path}")
```

这项检查能够发现缺少必填字段、节点连接不合法、算子定义不符合当前版本等结构问题。它不执行推理，也不了解目标 NPU 的算子支持范围。因此“检查通过”不能推出“后端一定可以转换”或“输出数值一定正确”。

### 2.2 模型输入输出名称、形状和数据类型检查

第二项检查只看图对外暴露的接口：

- 输入和输出数量是否符合调用程序预期。
- 名称是否与推理代码准备绑定的名称一致。
- 元素数据类型是否正确。
- 秩和各维含义是否正确。
- 应当动态的维度是否显示为符号，固定维度是否显示为具体整数。

权重初始化器有时也会出现在旧模型的图输入列表中。读取真实业务输入时，可以排除与初始化器同名的项目：

```python
from onnx import TensorProto


def describe_value(value_info):
    """把一个图输入或图输出转换成便于人工检查的名称、类型和形状。"""
    tensor_type = value_info.type.tensor_type
    element_type = TensorProto.DataType.Name(tensor_type.elem_type)

    dimensions = []
    for dimension in tensor_type.shape.dim:
        if dimension.HasField("dim_value"):
            # 静态维度直接保存整数长度。
            dimensions.append(str(dimension.dim_value))
        elif dimension.dim_param:
            # 动态维度保存符号名称，例如 batch、height。
            dimensions.append(dimension.dim_param)
        else:
            # 问号表示当前模型没有提供具体长度或符号。
            dimensions.append("?")

    return value_info.name, element_type, dimensions


initializer_names = {
    initializer.name for initializer in onnx_model.graph.initializer
}
real_inputs = [
    value
    for value in onnx_model.graph.input
    if value.name not in initializer_names
]

print("模型输入：")
for value in real_inputs:
    print(describe_value(value))

print("模型输出：")
for value in onnx_model.graph.output:
    print(describe_value(value))
```

例如固定 YOLO11n 输入应看到四维 `[1, 3, 640, 640]`。如果输入形状变成 `[1, 640, 640, 3]`，说明当前模型接口采用 NHWC 布局或导出前发生了维度交换，部署预处理必须按实际接口调整。不能只凭“都是四维”判断输入正确。

### 2.3 算子集版本、自定义算子域与后端支持检查

算子域（operator domain）可以先理解为算子名称前面的“命名空间”。它用来区分由不同组织定义的同名算子。例如默认域中的 `Conv` 表示 ONNX 标准卷积；如果某个厂商在 `com.vendor` 域中也定义了名为 `Conv` 的算子，完整身份就是“`com.vendor` 域的 `Conv`”，不能按标准 ONNX 卷积解释。

模型通过 `opset_import` 分别声明每个算子域采用的版本。默认域 `""` 和 `ai.onnx` 表示标准 ONNX 算子；`ai.onnx.ml` 用于 ONNX 的传统机器学习算子；项目或厂商自定义域需要目标后端提供对应实现或转换规则。第三项检查读取这些声明，并确认图中是否出现目标后端无法解释的自定义算子域。

```python
print("模型声明的算子集：")
for opset in onnx_model.opset_import:
    domain_name = opset.domain if opset.domain else "ai.onnx（默认域）"
    print(f"  域={domain_name}，版本={opset.version}")

custom_nodes = [
    node
    for node in onnx_model.graph.node
    if node.domain not in ("", "ai.onnx")
]
if custom_nodes:
    print("发现非标准算子域节点：")
    for node in custom_nodes:
        print(f"  域={node.domain}，算子={node.op_type}，名称={node.name}")
else:
    print("未发现非标准算子域节点")
```

标准域也不代表后端支持全部节点。实际判断仍以目标转换器的支持表和转换日志为准。日常无需逐个核对所有普通节点；只有转换器明确报出不支持的算子，或模型含有非标准域时，再定位对应节点、版本、输入类型和属性。

### 2.4 使用Netron确认主数据流与图输出

Netron 是模型结构可视化工具，基础操作见阶段3-6第3节。本阶段只确认四件事：

1. 图输入是否进入模型主干，没有在开头就经过意外的维度交换或数据类型转换。
2. 主干是否连续连接到检测头，没有断开的分支。
3. 图输出是否来自预期的最后计算节点。
4. 输出数量和各输出形状是否与第2.2节的代码结果一致。

不需要逐个打开卷积节点，也不需要人工审查每个权重和属性。节点较多时，沿输入到输出的主数据线查看即可。若转换日志已经指出节点名称，再用 Netron 搜索该名称并检查它的直接上下游。

### 2.5 需要定位形状问题时执行形状推导

形状推导（shape inference）会根据已知输入形状和算子规则补充中间张量的形状信息。它适合“转换器报告某个中间张量形状不合法，但原图没有记录该张量形状”的情况。ONNX 官方说明指出，推导结果写入图的 `value_info`，且推导无法保证覆盖所有情况：[ONNX shape inference 文档](https://onnx.ai/onnx/api/shape_inference.html)。

```python
from onnx import shape_inference


# infer_shapes() 返回一个新的模型对象，不会自动改写磁盘上的原文件。
inferred_model = shape_inference.infer_shapes(
    onnx_model,
    check_type=True,
    strict_mode=True,
)

# 单独保存，保留原始导出文件用于对照。
onnx.save(inferred_model, "model_static_inferred.onnx")
print(
    f"形状推导前中间信息数量={len(onnx_model.graph.value_info)}，"
    f"推导后={len(inferred_model.graph.value_info)}"
)
```

输入输出信息已经完整、目标转换器也没有形状错误时，可以跳过这一步。形状推导只补充能够从规则确定的信息，不会修复错误轴号、错误拼接条件或错误布局。

## 3 ONNX导出与检查中的常见问题及解决方法

### 3.1 `.pt`只包含参数导致模型无法直接导出

很多刚接触模型导出的人只拿到训练脚本生成的 `best_weights.pt`，会把“文件后缀是 `.pt`”理解成“加载后一定是模型”。于是直接执行：

```python
import torch


dummy_input = torch.randn(1, 3, 640, 640)

# 错误假设：认为 torch.load() 返回的一定是可执行模型。
model = torch.load(
    "best_weights.pt",
    map_location="cpu",
    weights_only=True,
)
torch.onnx.export(model, (dummy_input,), "model.onnx")
```

如果这个文件由 `torch.save(model.state_dict(), ...)` 保存，`model` 的实际类型就是 `dict` 或有序字典 `OrderedDict`。不同 PyTorch 导出路径给出的报错文字会有差别，常见信息包括：

```text
TypeError: 'dict' object is not callable
AttributeError: 'collections.OrderedDict' object has no attribute 'forward'
```

根本原因是参数字典只有类似 `{"backbone.conv.weight": 张量, ...}` 的参数名称和值，没有模型层之间的连接关系，也没有 `forward()` 前向计算方法。导出器无法让样例输入走过网络，自然不能捕获计算图。这个错误发生在导出开始阶段，不会生成可用 ONNX 文件。

正确做法是先取得模型类源码和建立模型所需的配置，再创建模型对象并装入参数：

```python
import torch

from my_project.models import build_model


dummy_input = torch.randn(1, 3, 640, 640)

# 1. 创建具有 forward() 前向逻辑的模型；此时参数还是初始化值。
model = build_model()

# 2. 文件只包含参数名称和张量。
state_dict = torch.load(
    "best_weights.pt",
    map_location="cpu",
    weights_only=True,
)

# 3. strict=True 要求所有参数名称与当前模型结构完全匹配。
model.load_state_dict(state_dict, strict=True)
model.eval()

# 4. 此时导出器拿到的是可执行模型对象。
torch.onnx.export(
    model,
    (dummy_input,),
    "model.onnx",
    input_names=["images"],
    output_names=["predictions"],
    opset_version=17,
    dynamo=True,
)
```

如果模型结构代码已经丢失，仅凭参数名称无法可靠恢复层属性、前向分支和张量变换。此时应向模型提供方索取结构源码、训练配置或可由原框架直接加载的检查点。

### 3.2 动态输入在导出后变成固定形状

一个常见场景是：开发者在 PyTorch 中分别输入 640×640 和 480×640 的图像，模型都能运行，于是认为导出的 ONNX 也会自动支持这两个尺寸。实际导出时使用了 `[1,3,640,640]` 样例输入，却没有设置 `dynamic_shapes`。用 Netron 或第2.2节脚本查看后，ONNX 输入明确显示为 `[1,3,640,640]`；运行时传入 `[1,3,480,640]` 会报告输入高度期望 640、实际得到 480。

导出器必须根据样例输入建立具体计算图。未声明动态轴时，样例中的批量 1、高度 640 和宽度 640 都会成为固定维度。另一种情况出现在模型内部：代码先把 `images.shape[2]` 转成 Python 整数，再参与 `Reshape` 或 `Resize` 的目标尺寸计算。导出期间这个整数等于 640，导出器便会把后续形状计算保存成常量。

最终后果是 ONNX 和后端编译模型只能接受导出尺寸。手工把图输入字段里的 640 改成符号也无法解决问题，因为模型内部的形状常量仍可能是 640，运行到形状变换或拼接节点时会再次失败。

下面只保留造成差异的关键参数。第一段没有动态维度声明，会生成固定输入；第二段明确声明批量、高和宽可以变化：

```python
import torch


example_images = torch.randn(1, 3, 640, 640)

# 错误场景：模型本身能处理多种尺寸，但导出时没有声明动态维度。
torch.onnx.export(
    model,
    (example_images,),
    "model_static.onnx",
    input_names=["images"],
    output_names=["predictions"],
    opset_version=17,
    dynamo=True,
)

# 正确场景：元组中的字典与第一个输入对应，键0、2、3分别是批量、高、宽轴。
torch.onnx.export(
    model,
    (example_images,),
    "model_dynamic.onnx",
    input_names=["images"],
    output_names=["predictions"],
    opset_version=17,
    dynamo=True,
    dynamic_shapes=(
        {
            0: torch.export.Dim("batch"),
            2: torch.export.Dim("height"),
            3: torch.export.Dim("width"),
        },
    ),
)
```

运行第2.2节的接口检查后，`model_static.onnx` 会显示整数 `[1,3,640,640]`；`model_dynamic.onnx` 的批量、高和宽位置会显示符号名称。这里只证明 ONNX 接口已经保留动态维度，目标后端是否接受这些动态轴仍由其支持范围决定。

解决时先确定目标硬件是否真正支持动态输入。支持时，在 PyTorch 当前导出接口中使用 `dynamic_shapes`，在 Ultralytics 中使用 `dynamic=True`，并让模型内部的尺寸计算保持为导出器可追踪的符号尺寸。重新导出后确认高、宽位置显示符号，再用目标后端允许的另一组尺寸运行。目标硬件要求固定输入时，应保留静态 ONNX，在图像预处理阶段统一缩放和补边。

### 3.3 未切换推理状态导致导出结果异常

例如，一个分类模型在分类头前包含随机失活层。开发者加载参数后直接计算参考输出并导出，同一张图片连续执行两次，类别分数却不一致；或者训练时批量为 32，导出样例批量为 1，批归一化层使用单张样本统计量后使输出明显偏移。

此时模型的 `training` 状态仍为 `True`。随机失活层在训练状态下会随机把部分值置零；批归一化层在训练状态下使用当前批次的均值和方差，并更新运行统计量。`torch.no_grad()` 只关闭梯度记录，不会改变这些层的行为。

导出的图可能记录训练路径，导出前得到的参考输出也不稳定。后续即使发现 ONNX 与某一次 PyTorch 输出不同，也无法判断差异来自导出、随机失活还是批归一化状态。

下面用一个随机失活层直接观察 `train()`、`eval()` 与 `inference_mode()` 的关系：

```python
import torch
from torch import nn


# 16个输入全部为1，随机失活层在训练状态下会随机保留其中一部分并缩放。
probe_model = nn.Sequential(nn.Dropout(p=0.5))
probe_input = torch.ones(1, 16)

probe_model.train()
with torch.inference_mode():
    torch.manual_seed(1)
    train_output_1 = probe_model(probe_input)
    torch.manual_seed(2)
    train_output_2 = probe_model(probe_input)

print("训练状态：", probe_model.training)
print("只关闭梯度后，两次输出相同：", torch.equal(train_output_1, train_output_2))

# eval() 修改模块状态；随机失活层在推理状态下直接传递输入。
probe_model.eval()
with torch.inference_mode():
    eval_output_1 = probe_model(probe_input)
    eval_output_2 = probe_model(probe_input)

print("推理状态：", probe_model.training)
print("调用eval()后，两次输出相同：", torch.equal(eval_output_1, eval_output_2))
print("推理输出等于原输入：", torch.equal(eval_output_1, probe_input))
```

前两次调用虽然放在 `inference_mode()` 中，输出仍会随随机种子变化，因为模型保持训练状态。调用 `eval()` 后，`training` 变为 `False`，两次输出都与输入相同。这个实验说明关闭梯度无法替代推理状态切换。

参数加载完成后应立即调用 `model.eval()`，然后使用同一输入建立 PyTorch 参考输出并执行导出。若仍要减少参考推理的内存占用，可以在 `eval()` 之后再配合 `torch.inference_mode()`；两个接口解决的问题不同。

### 3.4 算子集版本或算子类型不受目标后端支持

例如，模型使用算子集 18 导出，其中某个图像缩放节点采用该版本的 `Resize` 定义；目标转换器的支持表只覆盖到算子集 13。ONNX 检查器仍会通过，因为这个图符合 ONNX 18 规范，转换器随后会在 `Resize` 节点报告版本、输入形式或属性组合不支持。

算子集版本决定标准算子的具体定义。后端实现进度由厂商决定，因此“ONNX 标准允许”与“当前后端已经实现”是两项独立条件。同一个后端还可能支持 `Conv` 的 32 位浮点输入，却不支持该节点的某种整数类型或分组配置。

转换会停在第一个无法映射到后端实现的节点，最终不会生成可执行模型。后续日志中的形状错误还可能由这个节点未成功转换引起。

解决时记录转换日志中的第一个失败节点、算子域、算子类型和模型的 `opset_import`，再对照目标后端当前版本的支持表。后端支持较低算子集时，用对应 `opset_version` 重新导出；某个 PyTorch 操作始终生成后端不支持的节点时，在 PyTorch 模型中改成后端支持的等价计算。直接修改 ONNX 文件中的版本数字不会重写节点定义。

### 3.5 结构检查通过但目标后端转换失败

例如，一个 ONNX 模型包含合法的五维 `Transpose`，轴顺序为 `[0,2,1,3,4]`。`onnx.checker.check_model()` 检查后没有错误，因为轴数量与输入秩相符，节点满足 ONNX 规范。目标 NPU 转换器只实现了二维到四维张量的该操作，于是构建阶段报告“该节点输入秩不支持”。

检查器负责验证模型格式、节点连接和 ONNX 标准约束。目标后端还会限制输入秩、固定或动态形状、数据类型、轴、广播方式、内存和硬件实现。阶段4-1第7节已经讲过轴越界、广播与数据类型问题；这些规则通过后，仍需满足厂商支持范围。

因此，结构合法的 ONNX 文件依然可能无法生成 NPU 模型。排查时以转换器报告的第一个失败节点为起点，读取它的输入形状、数据类型、属性和直接上游，再查后端对该算子的附加限制。日志只给出张量名称时，先运行第2.5节的形状推导，再到 Netron 中搜索该张量。处理第一个根因后重新转换，避免同时追逐由它引起的连锁错误。

### 3.6 YOLO输出数量或维度含义理解错误

例如，开发者以前接入过一个返回“边框张量、类别张量、置信度张量”的检测模型，于是沿用三个输出的后处理代码。当前 YOLO11n ONNX 实际只有一个输出，程序取得第二个输出时直接越界。另一种错误是看到 `[1,84,8400]` 后，把 84 当成候选框数量，把 8400 当成每个候选框的特征数。

YOLO 输出接口由模型任务、类别数、输入尺寸以及导出时是否把非极大值抑制（Non-Maximum Suppression，NMS）放进图中共同决定。在本演示的 640×640 输入、批量 1、标准 80 类和图外 NMS 配置下，YOLO11n 的原始检测输出为 `[1,84,8400]`：84 由 4 个边框量和 80 个类别分数组成，8400 是三个检测尺度的候选位置总数：

$$
8400=80\times80+40\times40+20\times20
$$

自定义模型若有 $C$ 个类别，对应通道数为 $4+C$。分割和姿态模型还会增加输出或通道，因此必须读取当前文件的实际接口。

轴含义理解错误后，后处理会在 84 个通道中挑选“候选框”，把类别分数当坐标，最后产生完全错误的边框；输出数量理解错误则会直接导致数组越界。正确做法是先打印第2.2节的图输出，再结合任务、类别数和导出配置说明每个输出和每个轴。后处理代码应绑定当前文件的输出名称和形状，NMS 位于图内还是图外也要按实际导出图确认。

### 3.7 模型简化导致动态维度或输出结果变化

例如，原始模型用输入高、宽计算后续 `Reshape` 的目标形状，输入接口显示 `[batch,3,height,width]`。简化后，相关形状子图消失，`Reshape` 的目标形状直接变成按 640×640 样例计算出的常量。固定 640×640 输入仍能运行，换成 480×640 后在形状变换处失败。

简化工具会删除冗余节点，并提前计算所有输入都已经固定的子图。这个提前计算称为常量折叠，工作方式见阶段4-1第6.2节。若导出图已经把某个动态尺寸变成固定样例值，简化器会把后续计算结果直接保存成常量。另一些差异来自简化工具版本中的具体图改写规则。

后果有两类：动态模型失去部分动态能力；某个等价改写产生数值差异，进而改变边框坐标或类别分数。文件体积变小和节点减少无法证明结果仍正确。

应先导出 `simplify=False` 的原始模型并保留，然后复制一份执行简化。两份模型分别检查输入输出和动态轴，再使用完全相同的输入比较输出。阶段4-3会完成数值基线比较。发现动态维度被固定或误差超过项目阈值时，应继续使用原始模型，或更换简化工具版本并定位具体改写。

## 4 YOLO11n从`.pt`导出ONNX与必要检查Demo

### 4.1 两个`.pt`转ONNX的演示

本节包含两个相互独立的演示（Demo）：

1. 使用官方 Ultralytics Python 接口，把普通 `yolo11n.pt` 导出为官方输出结构的 ONNX。
2. 使用 RKNN Model Zoo 指向的 Rockchip YOLO11 修改分支，把同一类 `yolo11n.pt` 导出为适配瑞芯微神经网络处理单元（Rockchip Neural Processing Unit，RKNPU）的 ONNX。

两条路线都从训练权重开始，但导出的输出接口不同：

```text
-----------------------------+
| 普通 yolo11n.pt             |
-----------------------------+
          | 官方 Ultralytics export()
          v
-----------------------------+
| 官方输出结构的 yolo11n.onnx |
-----------------------------+

-----------------------------+
| 普通 yolo11n.pt             |
-----------------------------+
          | RKNN Model Zoo 配套的 export.py
          v
----------------------------------+
| RKNPU 适配输出结构的 yolo11n.onnx |
----------------------------------+
```

第二个演示只讨论 `rknn_model_zoo/examples/yolo11/python/export.py` 完成的 `.pt → ONNX` 导出。这里不继续转换 `.rknn`。该脚本使用 Rockchip 调整过的 YOLO11 导出逻辑，重点是改变检测头在导出时交出的内容，使 ONNX 更适合后续嵌入式部署。RKNN Model Zoo 的 YOLO11 说明也明确区分了官方 ONNX 与优化 ONNX 的输出结构：[RKNN Model Zoo YOLO11示例](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/README.md)。

### 4.2 Ultralytics官方`yolo11n.pt`导出ONNX

先在独立目录中准备官方或自己训练得到的 `yolo11n.pt`，避免与第二个演示产生同名文件冲突：

```bash
mkdir -p yolo11_onnx_demo/official
cd yolo11_onnx_demo/official

python3 -m venv .venv
source .venv/bin/activate
python -m pip install torch ultralytics onnx onnxscript
python -m pip freeze > environment.txt
```

Windows PowerShell 的虚拟环境激活命令为 `.\.venv\Scripts\Activate.ps1`。把 `yolo11n.pt` 放进当前目录，然后创建 `export_official_yolo11n.py`：

```python
from pathlib import Path

import onnx
import torch
import ultralytics
from ultralytics import YOLO


MODEL_PATH = Path("yolo11n.pt")
OPSET_VERSION = 17

if not MODEL_PATH.is_file():
    raise FileNotFoundError(
        f"找不到 {MODEL_PATH.resolve()}，请先准备可信来源的 yolo11n.pt"
    )

print(f"PyTorch版本：{torch.__version__}")
print(f"Ultralytics版本：{ultralytics.__version__}")
print(f"ONNX版本：{onnx.__version__}")

# YOLO() 负责识别 Ultralytics 检查点，恢复检测任务、模型结构和参数。
yolo_model = YOLO(str(MODEL_PATH))

# 本演示建立固定 640×640、批量 1 的原始导出基线。
# simplify=False 会保留未经 onnxslim 额外简化的图，便于后续定位导出问题。
exported_path = yolo_model.export(
    format="onnx",
    imgsz=640,
    batch=1,
    dynamic=False,
    simplify=False,
    opset=OPSET_VERSION,
    device="cpu",
)

exported_path = Path(exported_path)
if not exported_path.is_file():
    raise FileNotFoundError(
        f"导出接口返回了 {exported_path}，但磁盘上没有该文件"
    )

print(f"官方ONNX：{exported_path.resolve()}")
```

运行：

```bash
python export_official_yolo11n.py
```

Ultralytics 当前官方接口使用 `YOLO("yolo11n.pt").export(format="onnx", ...)` 完成导出，`imgsz`、`batch`、`dynamic`、`simplify` 和 `opset` 控制本节关心的结果：[Ultralytics模型导出文档](https://docs.ultralytics.com/modes/export/)。对标准 80 类 YOLO11n 检测模型，本演示的官方原始输出接口为 `[1,84,8400]`，其维度含义见第3.6节。

### 4.3 官方导出结果的必要检查

创建 `inspect_one_onnx.py`：

```python
from pathlib import Path

import onnx
from onnx import TensorProto


MODEL_PATH = Path("yolo11n.onnx")


def describe_value(value_info):
    """返回一个图输入或图输出的名称、元素类型和形状。"""
    tensor_type = value_info.type.tensor_type
    dtype = TensorProto.DataType.Name(tensor_type.elem_type)
    shape = []

    for dimension in tensor_type.shape.dim:
        if dimension.HasField("dim_value"):
            shape.append(str(dimension.dim_value))
        elif dimension.dim_param:
            shape.append(dimension.dim_param)
        else:
            shape.append("?")

    return value_info.name, dtype, shape


if not MODEL_PATH.is_file():
    raise FileNotFoundError(f"找不到模型：{MODEL_PATH.resolve()}")

model = onnx.load(MODEL_PATH)
onnx.checker.check_model(model)

print("结构检查：通过")
print("算子集：")
for imported_opset in model.opset_import:
    domain = imported_opset.domain or "ai.onnx（默认域）"
    print(f"  域={domain}，版本={imported_opset.version}")

print("输入：")
for value in model.graph.input:
    print(f"  {describe_value(value)}")

print("输出：")
for value in model.graph.output:
    print(f"  {describe_value(value)}")
```

运行 `python inspect_one_onnx.py` 后，应看到结构检查通过、标准 ONNX 算子集版本为 17、输入为 `[1,3,640,640]`。输出名称由当前 Ultralytics 版本生成，推理代码应读取实际名称，不能在未检查模型时自行猜测。

### 4.4 用瑞芯微的库导出适合rk3588的onnx

在将 YOLO11 部署到 RK3588 之前，需要先完成模型训练，然后将训练得到的 `.pt` 模型转换为适合瑞芯微 RKNPU 工具链使用的 ONNX 模型。

这里需要先区分两个阶段所使用的工具：

* **YOLO11 的 `.pt → .onnx`**：使用瑞芯微提供的 `airockchip/ultralytics_yolo11`。
* **`.onnx → .rknn`**：使用 `rknn_model_zoo` 中的转换程序，并依赖 RKNN-Toolkit2。

因此并不是直接使用普通 Ultralytics 将模型导出成 ONNX，再交给 RKNN-Toolkit2。瑞芯微针对 YOLO11 修改了 Ultralytics 的模型输出结构，例如移除了部分不利于量化的后处理结构，并将 DFL 等处理移动到了模型外部，以便后续在 RK3588 NPU 上运行。瑞芯微官方的 YOLO11 示例也是按照这一方式进行模型转换的。

下面先从一个最简单的 YOLO11 数据集训练开始。

#### 4.4.1 Windows 下训练 YOLO11 模型

##### 1. 创建 Python 虚拟环境并安装 Ultralytics

如果 Windows 中已经安装了 Miniconda，可以直接从普通 CMD 进入 Conda 环境，不一定要专门打开“Anaconda Prompt”。

例如 Miniconda 安装在 `F:\miniconda`，在 CMD 中可以直接运行：

```bat
F:\miniconda\Scripts\activate.bat
```

执行以后，命令行前面一般会出现 `(base)`，表示已经加载 Conda。

如果希望以后在 CMD 中直接使用 `conda` 命令，也可以在成功进入 Conda 后执行一次 `conda init cmd.exe`，之后重新打开 CMD 即可。

接下来创建一个用于 YOLO11 训练的 Python 3.10 环境：

```bat
conda create -n 310_AILearn python=3.10 -y
conda activate 310_AILearn
```

进入环境以后安装 Ultralytics：

```bat
pip install ultralytics
```

训练阶段使用的是官方 Ultralytics，因此这里直接通过 `pip install ultralytics` 安装即可。

可以使用下面的命令检查是否安装成功：

```bat
yolo version
```

如果能够正常输出 Ultralytics 版本信息，就可以开始准备数据集。

##### 2. 创建 YOLO 数据集目录

YOLO 目标检测的数据一般按照 `images` 和 `labels` 分别保存图片与标签，再将两者划分为训练集和验证集。

例如创建如下目录：

```text
train_test_sucai/
├── images/
│   ├── train/
│   └── val/
├── labels/
│   ├── train/
│   └── val/
└── data.yaml
```

`images/train` 中保存训练图片，`images/val` 中保存验证图片；对应的 YOLO 标签分别放在 `labels/train` 和 `labels/val` 中。

例如存在图片 `images/train/001.jpg`，那么它对应的标签必须是 `labels/train/001.txt`。

YOLO 检测标签中的每一行代表一个目标，格式为：

```text
class_id center_x center_y width height
```

例如：

```text
0 0.512 0.436 0.233 0.158
```

其中 `class_id` 是类别编号，后面的中心坐标以及目标宽高都已经按照图片尺寸归一化到 `0~1`。

如果只是为了验证训练、模型转换和部署流程，并不要求最终检测精度，那么数据集不需要很大。比如只准备几张到几十张图片即可，将大部分放入 `train`，少量放入 `val`。

接下来创建 `data.yaml`。假设这里只有一个目标类别 `pothole`，可以写成：

```yaml
path: .

train: images/train
val: images/val

names:
  0: pothole
```

这里没有单独填写 `labels` 的路径，是因为 Ultralytics 会根据图片路径自动推导标签路径。例如读取 `images/train/001.jpg` 时，会自动查找对应的 `labels/train/001.txt`。

如果有多个类别，则继续增加 `names` 即可，例如：

```yaml
names:
  0: pothole
  1: cone
  2: barrel
```

类别编号必须与标签文件中的 `class_id` 保持一致。

##### 3. 使用命令行启动训练

准备好数据后，在 CMD 中进入数据集所在目录，例如：

`cd /d D:\AI学习\yolo11n_test\train_test_sucai`

然后启动训练：

```bat
yolo detect train model=yolo11n.pt data=data.yaml epochs=5
```

其中 `model=yolo11n.pt` 表示使用 YOLO11n 的预训练权重开始训练，`data=data.yaml` 指定数据集配置，`epochs=5` 表示训练 5 个 epoch。

这里需要注意参数是 `epochs`，而不是 `epoch`。

如果没有特殊指定，YOLO 默认会以 640×640 的输入尺寸训练。对于这里只验证流程的小数据集，不需要训练很多轮。

训练完成后，一般可以在 `runs/detect/train/weights/` 中找到：

```text
best.pt
last.pt
```

其中 `best.pt` 是后续进行 ONNX 转换时使用的模型。

模型的类别数已经保存在 `best.pt` 中。例如训练时只有 `pothole` 一个类别，那么后续导出 ONNX 时不需要再次手动指定 `nc=1`。

#### 4.4.2 Linux 下完成同样的 YOLO11 训练流程

Linux 下的整体流程与 Windows 基本一致，只是可以直接使用 Python 的 `venv` 创建虚拟环境，不需要额外安装 Conda。

首先确认系统中已经安装 Python。例如：

`python3 --version`

如果当前系统是 Python 3.8，可以安装对应的 venv：

```bash
sudo apt update
sudo apt install python3.8-venv
```

然后创建虚拟环境：

```bash
python3.8 -m venv yolo_train_env
source yolo_train_env/bin/activate
```

激活以后，终端前面会出现类似 `(yolo_train_env)` 的标记。

安装官方 Ultralytics：

```bash
python -m pip install --upgrade pip
pip install ultralytics
```

数据集目录结构与 Windows 完全相同：

```text
train_test_sucai/
├── images/
│   ├── train/
│   └── val/
├── labels/
│   ├── train/
│   └── val/
└── data.yaml
```

`data.yaml` 的内容也不需要修改。进入数据集目录后直接执行：

```bash
yolo detect train model=yolo11n.pt data=data.yaml epochs=5
```

最终同样获得 `best.pt`。

需要注意，以上 Windows 和 Linux 部分只是普通 YOLO11 的**训练过程**。下面进入 RK3588 部署以后，不再继续使用通过 `pip install ultralytics` 得到的官方 Ultralytics，而是换成瑞芯微修改过的 `airockchip/ultralytics_yolo11`。

---

#### 4.4.3 使用瑞芯微 ultralytics_yolo11 将 PT 转换为 ONNX

瑞芯微为 YOLO11 提供了专门修改过的 Ultralytics 仓库 `airockchip/ultralytics_yolo11`。这个仓库是在官方 Ultralytics 的基础上修改的，主要目的是生成更加适合 RKNPU 后续转换和推理的 ONNX。

根据瑞芯微的说明，其主要修改包括模型输出结构、后处理结构以及 DFL 部分。这些变化不会要求重新训练原来的 YOLO11 模型，因此前面使用官方 Ultralytics 训练出来的 `best.pt` 可以直接使用。

这个库也可以用来训练pt，但和官方的流程一样。所以还是推荐pt的训练用官方的Ultralytics。

整个转换过程建议在 Linux 中进行，并且单独创建一个 Python 虚拟环境，避免训练环境和后续 Rockchip 工具链之间的依赖发生冲突。

##### 1. 创建并进入虚拟环境

如果系统使用 Python 3.8，可以执行：

```bash
python3.8 -m venv yolo11_env
source yolo11_env/bin/activate
```

激活后可以通过 `which python` 检查当前 Python 是否来自虚拟环境。例如正常情况下可能输出 `/home/用户名/yolo11_env/bin/python`。

后续安装和转换操作都应保持 `(yolo11_env)` 处于激活状态。

##### 2. 下载瑞芯微修改版 YOLO11

进入准备存放工程的目录，然后执行：

```bash
git clone https://github.com/airockchip/ultralytics_yolo11.git
cd ultralytics_yolo11
```

下载完成以后，当前目录就是瑞芯微修改后的 Ultralytics 源码。

##### 3. 安装当前目录中的 ultralytics_yolo11

首先建议升级 pip：

```bash
python -m pip install --upgrade pip setuptools wheel
```

然后在 `ultralytics_yolo11` 根目录执行：

```bash
pip install -e .
```

这里的 `pip install -e .` 和 `pip install ultralytics` 含义不同。

`pip install ultralytics` 会从 PyPI 下载 Ultralytics 官方发布的版本，而这里需要使用的是瑞芯微修改过的源码，因此不能用它替代当前仓库。

`pip install -e .` 中的 `.` 表示安装**当前目录中的 Python 项目**，也就是刚才通过 Git 下载下来的 `ultralytics_yolo11`。`-e` 表示 editable install，即让当前虚拟环境直接关联这份源码。

可以将这个过程理解为：

```text
git clone
    ↓
将瑞芯微修改版 Ultralytics 源码下载到本地

pip install -e .
    ↓
将当前这份源码注册到 Python 虚拟环境，并安装它所需要的依赖
```

因此，虽然源码已经通过 Git 下载到了硬盘上，但仍然需要执行 `pip install -e .`，让当前 Python 环境能够正确加载这套代码以及对应依赖。

如果国内网络环境下通过 pip 下载依赖速度很慢，可以添加镜像源，例如：

```bash
pip install -e . -i https://pypi.tuna.tsinghua.edu.cn/simple
```

也可以将镜像源永久配置到 pip：

```bash
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
```

之后再执行普通的 `pip install` 就会默认使用该镜像。

##### 4. 安装 ONNX 相关工具

为了导出和检查 ONNX，可以继续安装：

```bash
pip install onnx onnxruntime
```

如果之前配置了 pip 镜像，则这里不需要再次添加镜像地址。

##### 5. 放入 best.pt 并修改 default.yaml

将前面训练得到的 `best.pt` 放到 `ultralytics_yolo11` 的根目录，例如：

```text
ultralytics_yolo11/
├── best.pt
├── ultralytics/
├── pyproject.toml
├── RKOPT_README.zh-CN.md
└── ...
```

然后打开 `ultralytics/cfg/default.yaml`，找到 `model:` 配置项，将其修改为：

```yaml
model: best.pt
```

瑞芯微官方的导出方式就是通过修改这里的 `model` 路径来指定需要导出的模型。检测、分割、姿态和 OBB 等模型都可以根据对应的 `.pt` 文件进行导出。

如果训练时使用的是 640×640 输入，还应确认配置中的：

```yaml
imgsz: 640
```

另外，在实际 RK3588 单帧推理场景中，通常建议将：

```yaml
batch: 1
```

这样导出的 ONNX 输入通常为：

```text
(1, 3, 640, 640)
```

而不是训练时可能使用的较大 batch。

对于类别数量则不需要重新设置。例如前面训练得到的 `best.pt` 只有一个类别，那么类别数量已经保存在模型内部，导出程序会根据 `best.pt` 自动得到对应的检测头结构。

##### 6. 设置 PYTHONPATH 并导出 ONNX

确保当前终端位于 `ultralytics_yolo11` 根目录，然后执行：

```bash
export PYTHONPATH=./
python ./ultralytics/engine/exporter.py
```

这里先执行 `export PYTHONPATH=./`，是为了将当前工程根目录加入 Python 的模块搜索路径。

因为这里运行的是仓库内部的 `ultralytics/engine/exporter.py`，而它还需要继续导入当前仓库中的 `ultralytics` 其他模块。将 `PYTHONPATH` 指向当前目录，可以明确告诉 Python：优先从这个工程目录中寻找需要导入的模块。

这对于当前场景尤其重要，因为我们希望运行的是**瑞芯微修改后的 Ultralytics**，而不是系统中可能存在的另一份官方 Ultralytics。

瑞芯微官方给出的 YOLO11 ONNX 导出流程同样是在工程根目录先设置 `PYTHONPATH=./`，然后直接运行 `ultralytics/engine/exporter.py`。

正常转换时，可以看到类似下面的信息：

```text
PyTorch: starting from 'best.pt' ...
RKNN: starting export ...
RKNN: feed best.onnx to RKNN-Toolkit or RKNN-Toolkit2 to generate RKNN model.
RKNN: export success, saved as 'best.onnx'
```

完成以后，在 `ultralytics_yolo11` 根目录中即可找到：

`best.onnx`

例如：

```text
ultralytics_yolo11/
├── best.pt
├── best.onnx
├── ultralytics/
└── ...
```

至此已经完成：

```text
YOLO11 训练
      ↓
best.pt
      ↓
airockchip/ultralytics_yolo11
      ↓
best.onnx
```

需要特别注意，此时得到的只是适合瑞芯微后续工具链使用的 **ONNX 模型**，还没有得到能够直接在 RK3588 NPU 上加载的 `.rknn` 模型。

下一步将使用另一套工具：

```text
best.onnx
      ↓
rknn_model_zoo + RKNN-Toolkit2
      ↓
best.rknn
```

`rknn_model_zoo` 官方的 YOLO11 示例提供了对应的 `convert.py`，内部会依次调用 RKNN-Toolkit2 的 `load_onnx()`、`build()` 和 `export_rknn()`，最终生成 RK3588 使用的 RKNN 模型。官方 YOLO11 示例中的典型转换形式为 `python convert.py <onnx_model> rk3588`。

因此这两个仓库的职责不要混淆：

```text
airockchip/ultralytics_yolo11
负责：PT → 适配 RKNPU 的 ONNX

airockchip/rknn_model_zoo + RKNN-Toolkit2
负责：ONNX → RKNN，以及后续 Python/C 推理示例
```

后续即可继续使用 `rknn_model_zoo/examples/yolo11` 将这里生成的 `best.onnx` 转换为适用于 RK3588 的 `best.rknn`。


