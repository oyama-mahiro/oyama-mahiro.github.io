---
title: '[嵌入式AI-推理部署] PyTorch转ONNX时的常见算子问题与处理'
published: 2026-09-24T08:32:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍PyTorch转ONNX时的常见算子问题与处理的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-5 PyTorch转ONNX时的常见算子问题与处理

PyTorch模型转成ONNX时，常见问题主要集中在三处：Python控制流程无法形成稳定计算图、算子及其版本超出部署端支持范围，以及本应变化的形状在导出时被固定。本章只讨论这些高频问题，并给出一个可运行的算子集版本实验。

## 1 数据相关的控制流程无法正常导出

### 1.1 常见表现

下面的模型根据输入数据决定执行哪个分支：

```python
import torch
from torch import nn


class BranchModel(nn.Module):
    def forward(self, x):
        # x.sum()的结果只有真正运行时才能确定。
        if x.sum() > 0:
            return x * 2
        return -x
```

这种写法在普通Python程序中没有问题，导出ONNX时却可能出现两种表现：

- 使用当前推荐的ONNX导出方式时，导出器可能直接报错，错误信息中常能看到“数据相关表达式无法确定”一类提示。PyTorch官方控制流程教程展示的典型信息是 `Could not guard on data-dependent expression`。
- 使用旧式跟踪方式导出时，导出过程可能只执行样例输入选中的分支。例如样例输入的元素之和大于0，ONNX图中可能只留下 `x * 2`。以后输入元素之和小于0时，模型仍然计算 `x * 2`，结果便与原PyTorch模型不同。

### 1.2 原因、后果和处理方法

执行 `if x.sum() > 0` 时，Python必须先把判断条件变成一个确定的真或假。ONNX计算图需要保存两个分支及其选择条件，单纯执行一次Python代码无法自动表达完整分支关系。当前PyTorch导出器遇到这种无法确定的控制流程，通常会停止导出，避免生成含义错误的模型。相关限制和改写方式可参考[PyTorch官方ONNX控制流程教程](https://docs.pytorch.org/tutorials/beginner/onnx/export_control_flow_model_to_onnx_tutorial.html)。

处理方式应根据分支用途选择：

1. 两个结果形状相同，并且只需逐元素选择时，可以把条件改写成 `torch.where(condition, value_a, value_b)`。
2. 两个分支包含多步计算时，可以使用 `torch.cond()` 明确提供条件、真分支和假分支，让导出器获得两个完整分支。
3. 分支属于图片读取、业务规则或结果筛选时，可以将它移到ONNX模型外，由调用程序执行。

修改后需要分别准备能进入两个分支的输入，对比PyTorch和ONNX Runtime的输出。只用导出时的那一组样例输入进行比较，仍然可能漏掉另一条分支的问题。

## 2 PyTorch操作、算子集版本和部署端支持范围不匹配

### 2.1 不匹配可能发生在哪一层

一个PyTorch操作能够部署，需要连续通过三层支持关系：

1. PyTorch导出器知道如何把该操作转换成ONNX节点。
2. 导出时选择的算子集版本中存在所需ONNX算子和属性。
3. ONNX Runtime、芯片转换工具或其他部署端实现了这个算子版本及其参数组合。

因此，同一个问题可能在不同阶段暴露：

- 导出时失败：错误信息常包含某个 `aten` 操作、找不到对应ONNX转换规则，或者当前算子集版本不支持该操作。
- 导出成功，加载或转换时失败：错误会指向ONNX节点名称、算子类型、算子域或版本。
- 模型可以运行，但输出有明显偏差：这种情况常见于插值、坐标变换等存在多种计算规则的算子。

算子集版本的选择要以部署端为准。PyTorch官方文档也要求根据目标运行时或编译器的支持范围设置 `opset_version`，具体参数用法已经在《阶段4-2》第1.3节和第1.5节说明，可参考[PyTorch ONNX导出文档](https://docs.pytorch.org/docs/stable/onnx)。

### 2.2 几个常见的版本不匹配例子

| PyTorch中的操作 | ONNX中的常见表示 | 可能出现的表现 | 原因与具体处理 |
| --- | --- | --- | --- |
| `torch.nn.functional.grid_sample()` | `GridSample` | 使用较低算子集版本时导出失败；换成较高版本后能导出，部署工具又提示不支持该节点 | `GridSample`从ONNX算子集16开始提供。先确认部署端是否支持16及该算子；若它只用于固定的缩放或简单变换，可改成部署端支持的 `Resize`，也可以把几何变换放到模型外完成。[ONNX GridSample定义](https://onnx.ai/onnx/operators/onnx__GridSample.html) |
| `LayerNorm`或`GroupNorm` | 原生归一化节点，或者由多个基础节点组合而成 | 某台设备可以转换，另一台旧设备提示未知算子；也可能导出后根本看不到同名归一化节点 | 原生 `LayerNormalization`从算子集17开始提供，`GroupNormalization`从算子集18开始提供，后者在版本21中还调整了缩放量和偏置量的形状规定。导出器也可能将它们拆成求均值、减法和乘法等基础运算，所以应检查实际ONNX节点，再按部署端支持情况决定保留原生算子还是使用拆分形式。[LayerNormalization定义](https://onnx.ai/onnx/operators/onnx__LayerNormalization.html)、[GroupNormalization定义](https://onnx.ai/onnx/operators/onnx__GroupNormalization.html) |
| 可变形卷积 | `DeformConv`或某个自定义算子 | 普通卷积都能转换，运行到可变形卷积层时导出失败；也可能ONNX已生成，芯片转换工具仍停在该节点 | 标准 `DeformConv`从算子集19开始出现，不少旧部署端没有实现。单纯把模型的算子集版本改成19无法给部署端增加实现。可行办法包括更换为部署端支持的网络结构、使用部署端提供的扩展算子，或为目标运行时编写对应实现。[ONNX DeformConv定义](https://onnx.ai/onnx/operators/onnx__DeformConv.html) |
| `torch.nn.functional.interpolate()` | `Resize` | 转换工具提示不支持某个 `Resize` 版本或属性；模型虽然运行，边缘位置和PyTorch结果却有偏差 | `Resize`在多个算子集版本中持续增加输入形式、坐标变换方式和抗锯齿等属性。部署端声称支持 `Resize`，也不代表支持模型实际使用的节点版本和参数。应核对插值方式、坐标变换方式与节点版本，按目标后端要求重新导出，并对比边缘位置的数值。[ONNX Resize定义](https://onnx.ai/onnx/operators/onnx__Resize.html) |

这些例子说明，导出器支持某个PyTorch操作、ONNX标准包含对应算子、部署端实现对应版本，是三个不同条件。算子集版本越高，能表示的新算子通常越多，同时也更容易超出旧部署端的支持范围。

### 2.3 怎样定位并解决

遇到算子问题时，先从报错信息中记下PyTorch操作或ONNX节点，再依次确认以下内容：

1. 找到模型源码中的调用位置，确认它具体使用了哪些参数。例如 `interpolate` 的模式、对齐方式和输出大小都会影响转换结果。
2. 用Netron或ONNX模型结构查看工具确认最终节点的算子类型、算子域和模型使用的算子集版本。算子域类似命名空间，用来区分ONNX标准算子和某个框架或厂商定义的扩展算子。
3. 查目标部署端的算子支持表，核对准确版本和属性组合。只看到同名算子不能说明它一定可用。
4. 在三者共同支持的范围内选择算子集版本。若没有交集，再考虑改写网络、让导出器拆成基础算子、把操作移到模型外，或使用部署端扩展算子。

不要直接修改ONNX文件中的 `opset_import` 数字。节点的输入、属性和计算规则可能随版本变化，只改版本号不会自动改写节点，反而可能让模型得到错误解释。

## 3 样例输入使本应变化的形状被固定

### 3.1 常见表现和原因

假设导出时使用的样例输入形状是 `[1, 3, 640, 640]`。模型导出成功，换成 `[1, 3, 320, 320]` 后，ONNX Runtime可能报告输入尺寸不匹配，例如期望高度为640，实际收到320。

样例输入用于让导出器建立计算图。如果导出时没有声明需要变化的维度，高度和宽度通常会按样例值写入模型。还有一种更隐蔽的情况：模型内部把 `x.shape[-1]` 转成Python整数，再用它参与切片、循环或新张量创建。这个数值可能在导出时就变成640，输入维度即使被标记为动态，内部计算仍然保留固定值。

### 3.2 具体处理方法

先判断部署任务是否真的需要动态形状。固定输入在边缘设备中很常见，它便于内存规划和性能优化。此时可以保留固定ONNX输入，并在模型外统一缩放或填充到640×640。

确实需要多种尺寸时，使用当前导出方式的 `dynamic_shapes` 声明可变化维度，详细写法见《阶段4-2》第1.4节和第3.2节。模型内部还应避免把张量形状提前转换为普通Python整数，尽量使用能够保留在计算图中的形状运算。导出后至少使用两种不同尺寸运行模型，并检查输出形状及数值，才能确认动态维度贯穿了整个计算过程。

## 4 GridSample算子集版本不匹配实验

这个Demo只使用一个PyTorch操作：`torch.nn.functional.grid_sample()`。它最常见的结果是：使用算子集13导出时，导出器提示当前版本无法表示 `GridSample`；改成算子集16后，ONNX文件可以正常生成。根据[ONNX对GridSample的定义](https://onnx.ai/onnx/operators/onnx__GridSample.html)，这个算子从算子集16开始进入ONNX标准。

需要提前说明的是，改成算子集16只解决“ONNX能否表达该算子”的问题。模型还要交给具体部署端运行，因此部署端也必须实现算子集16中的 `GridSample`。如果部署端不支持，ONNX虽然能够导出，后续转换或加载仍然会失败。

先安装实验所需库：

```bash
pip install torch onnx onnxscript onnxruntime numpy
```

将下面代码保存为 `grid_sample_export_demo.py` 后运行：

```python
import numpy as np
import onnx
import onnxruntime as ort
import torch
import torch.nn.functional as F
from torch import nn


class GridSampleModel(nn.Module):
    """只保留一个grid_sample操作，方便观察它怎样转换成ONNX节点。"""

    def forward(self, image, grid):
        # image形状为[N, C, H, W]。
        # grid最后一维的两个数分别表示横坐标和纵坐标，取值通常位于[-1, 1]。
        # 输出会在grid指定的位置对image进行双线性采样。
        return F.grid_sample(image, grid, mode="bilinear", padding_mode="zeros", align_corners=False)


model = GridSampleModel().eval()

# 构造一个1×1×3×3的输入，数值清晰，方便发现导出前后的计算差异。
image = torch.arange(1, 10, dtype=torch.float32).reshape(1, 1, 3, 3)

# 生成四个采样点，因此模型输出空间大小为2×2。
# grid形状固定为[N, 输出高度, 输出宽度, 2]。
grid = torch.tensor(
    [[[[-0.5, -0.5], [0.5, -0.5]],
      [[-0.5,  0.5], [0.5,  0.5]]]],
    dtype=torch.float32,
)

# 第一次故意选择过低的算子集13。
# GridSample从算子集16才进入ONNX标准，多数情况下会在这里报告版本不支持。
try:
    torch.onnx.export(
        model, (image, grid), "grid_sample_opset13.onnx",
        input_names=["image", "grid"], output_names=["output"],
        opset_version=13, dynamo=True,
    )
    print("算子集13导出成功：当前导出器可能把grid_sample拆成了其他基础节点。")
except Exception as error:
    # 异常文本可能很长，这里输出第一行，并直接给出对应处理方向。
    first_line = str(error).splitlines()[0] if str(error) else type(error).__name__
    print("算子集13导出失败：", first_line)
    print("原因：算子集13没有标准GridSample定义。")
    print("解决：确认部署端支持后，把opset_version改为16或更高版本。")

# 第二次选择算子集16，让导出器能够使用标准GridSample节点。
onnx_path = "grid_sample_opset16.onnx"
torch.onnx.export(
    model, (image, grid), onnx_path,
    input_names=["image", "grid"], output_names=["output"],
    opset_version=16, dynamo=True,
)

# checker只检查ONNX文件的结构和节点定义是否合法。
# 即使这里通过，仍需根据部署端的算子支持表确认它能执行GridSample。
onnx_model = onnx.load(onnx_path)
onnx.checker.check_model(onnx_model)

# opset_import保存模型使用的算子域及版本；空域和ai.onnx都代表ONNX标准域。
for item in onnx_model.opset_import:
    domain = item.domain if item.domain else "ai.onnx"
    print(f"算子域与版本：{domain} opset {item.version}")

# 查看实际生成的节点。正常情况下可以在输出中看到ai.onnx::GridSample。
for node in onnx_model.graph.node:
    domain = node.domain if node.domain else "ai.onnx"
    print(f"节点：{domain}::{node.op_type}")

# 使用ONNX Runtime加载刚刚生成的ONNX模型。
session = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])

# session.run()接收NumPy数组。字典键必须和导出时设置的input_names一致。
ort_output = session.run(
    ["output"],
    {"image": image.numpy(), "grid": grid.numpy()},
)[0]

# 使用完全相同的输入运行原PyTorch模型，作为本次实验的数值参照。
with torch.inference_mode():
    torch_output = model(image, grid).numpy()

# 最大绝对误差接近0，说明这个样例中ONNX Runtime与PyTorch计算一致。
max_error = np.max(np.abs(torch_output - ort_output))
print("PyTorch输出：\n", torch_output)
print("ONNX Runtime输出：\n", ort_output)
print("最大绝对误差：", max_error)
```

运行这段代码后，可能出现下面三种结果。

**结果一：算子集13导出失败。**

错误信息通常会包含 `grid_sampler`、`GridSample`、`opset 13` 或“不支持的算子”等内容，例如：

```text
UnsupportedOperatorError: Exporting the operator 'aten::grid_sampler'
to ONNX opset version 13 is not supported.
```

这说明PyTorch模型中的 `grid_sample()` 已经被导出器识别，但算子集13没有可以保存该计算的标准 `GridSample` 节点。解决时先查看部署端支持的最高算子集版本：部署端支持算子集16和 `GridSample` 时，将 `opset_version` 改为16或更高版本后重新导出；部署端不支持时，继续提高版本也无法解决部署问题，需要采用结果二中的处理方法。

**结果二：算子集16导出成功，部署端转换或加载失败。**

ONNX检查可以通过，模型中也能看到 `ai.onnx::GridSample`，但芯片转换工具可能提示 `Unsupported op: GridSample`、`GridSample is not supported` 或类似错误。这说明ONNX文件本身合法，部署端没有实现这个节点，问题已经从导出阶段转移到部署阶段。

具体解决方法取决于 `grid_sample()` 在模型中的用途：

- 只完成普通缩放时，改用 `torch.nn.functional.interpolate()`，让模型导出为部署端更常支持的 `Resize`。
- 完成固定的裁剪、翻转或简单几何变换时，可以把该处理移到模型外，使用OpenCV或硬件图像处理单元完成。
- 完成空间变换、光流采样等无法直接替换的计算时，需要确认部署端是否提供扩展算子或自定义算子接口。部署端没有实现条件时，只修改ONNX算子集版本不会生效。

**结果三：算子集16导出成功，ONNX Runtime也能运行。**

输出中通常可以看到以下关键信息：

```text
算子域与版本：ai.onnx opset 16
节点：ai.onnx::GridSample
最大绝对误差：0.0
```

最大绝对误差也可能是一个接近0的浮点数，例如 `1e-7`。这表示当前输入下，ONNX Runtime与PyTorch结果基本一致。此时导出问题已经解决，接下来只需确认真正的目标部署端同样支持该节点。

少数较新的PyTorch导出器可能在算子集13下把 `grid_sample()` 拆成多个基础节点，因此第一次导出也可能成功。这时应查看脚本打印的节点：没有 `GridSample` 且PyTorch与ONNX Runtime输出接近，说明导出器使用了等价的基础算子组合；出现数值偏差时，应改用目标后端明确支持的算子集重新导出，并使用同一组输入对比原始输出。
