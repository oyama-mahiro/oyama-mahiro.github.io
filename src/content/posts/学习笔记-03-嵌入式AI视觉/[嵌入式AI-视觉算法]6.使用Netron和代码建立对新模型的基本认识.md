---
title: '[嵌入式AI-视觉算法] 使用Netron和代码建立对新模型的基本认识'
published: 2026-09-24T08:26:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍使用Netron和代码建立对新模型的基本认识的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '计算机视觉', '深度学习']
category: '嵌入式AI-视觉算法'
draft: false
lang: zh_CN
---

# 阶段3-6 使用Netron和代码建立对新模型的基本认识

> 当前掌握度：L1　建议时间：3小时

本文介绍一套通用的模型阅读方法。它适用于图像、文本、语音、传感器数据和普通数值Tensor，也适用于分类、回归、生成、检测、分割等不同任务。

核心问题是：模型文件真正接收什么数据，内部怎样传递Tensor，直接返回什么结果，哪些处理仍由模型外的程序完成。

```text
确认模型身份与任务
    ↓
阅读调用代码，记录模型前、模型接口和模型后的处理
    ↓
用Netron查看静态输入、输出和关键计算路径
    ↓
用PyTorch hook观察源码模块的运行时Tensor
    ↓
用ONNX API读取文件声明，用ONNX Runtime执行固定Tensor
    ↓
整理已证实结论和待验证问题
```

前7节只讲通用方法。第8节使用学习大纲指定的YOLO11n做具体练习，其中的RGB、DFL和NMS只属于这个检测案例。

---

## 1 阅读新模型前需要固定的来源、版本、任务和文件格式

分析结构之前，先确定模型身份。同一个文件名可能对应不同代码版本、训练任务、权重内容和导出设置，输入输出也会随之变化。

| 项目 | 需要记录的内容 | 影响 |
|---|---|---|
| 模型来源 | 官方仓库、发布页或内部模型库 | 决定到哪里寻找构建与调用代码 |
| 代码版本 | 包版本、Git提交号或发布标签 | 模块和导出行为可能随版本改变 |
| 任务类型 | 分类、回归、生成、检测、分割、语音识别等 | 决定输出Tensor怎样解释 |
| 文件与哈希 | 完整文件名和SHA-256 | 确认以后检查的仍是同一份内容 |
| 模型格式 | `.pt`、`.onnx`、`.tflite`、`.rknn`等 | 决定可查看的结构与运行工具 |
| 导出设置 | 动态维度、精度、量化和内置处理 | 直接改变计算图边界与接口 |
| 许可证 | 代码、权重和数据的许可证 | 判断能否用于当前项目 |

```powershell
# model.onnx替换为当前文件；SHA-256用于确认文件内容
Get-FileHash -Algorithm SHA256 .\model.onnx

# 保存当前Python包及其版本
python -m pip freeze > environment.txt
```

阅读报告开头应记录来源、版本、任务、模型格式、导出设置和文件哈希。未知项直接写“待确认”，后续结论才有明确的适用范围。

---

## 2 从模型调用代码确定预处理、输入和后处理约定

模型接口包含三段：模型前的数据准备、模型文件声明的输入输出、模型后的结果解释。Netron主要显示中间一段，另外两段要从实际调用代码确认。

| 数据或任务 | 模型前常见操作 | 模型后常见操作 |
|---|---|---|
| 图像 | 解码、颜色转换、缩放、归一化、维度排列 | 类别映射、框或掩码解码、坐标还原 |
| 文本 | 分词、词表查找、截断、补齐、attention mask | 取类别、token解码、停止条件、搜索策略 |
| 语音 | 解码、重采样、分帧、频谱或梅尔特征 | CTC解码、时间戳换算、文本整理 |
| 表格或传感器 | 缺失值处理、类别编码、标准化、时间窗口 | 反标准化、阈值判断、单位换算 |

所有模型都要记录输入输出名称、dtype、shape、每个维度的含义、数值范围或单位，以及动态维度在本次运行中的真实长度。

下面的函数把一次调用分成三段。三个可调用对象都来自实际项目，返回中间值是为了观察模型边界。

```python
def inspect_pipeline(raw_sample, preprocess, model_call, postprocess):
    """
    raw_sample：字符串、文件、数组或其他原始样本。
    preprocess：把原始样本转换为模型输入。
    model_call：调用当前推理后端并返回原始输出。
    postprocess：把原始输出转换为业务结果。
    """
    model_inputs = preprocess(raw_sample)
    raw_outputs = model_call(model_inputs)
    final_result = postprocess(raw_outputs)
    return model_inputs, raw_outputs, final_result
```

阅读时先在模型调用位置找到`model_inputs`，向前追踪生产代码，再从`raw_outputs`向后追踪消费者。文本模型可能接收`input_ids`与`attention_mask`；语音模型可能接收波形，也可能接收频谱。原始数据类型无法直接说明模型Tensor接口。

| 名称 | dtype | 实际shape | 维度含义 | 数值或编号含义 | 生产代码 |
|---|---|---|---|---|---|
| 按实际接口填写 | 按运行结果填写 | 按固定样本填写 | 逐维说明 | 范围、单位或词表 | 文件与函数位置 |

---

## 3 使用Netron读取模型输入输出和计算图

Netron是模型文件可视化工具，可只读查看ONNX、PyTorch等格式的计算图、输入输出、节点属性和权重信息。它不执行模型，因此运行时数值和模型外处理还需要代码验证。[Netron官方仓库](https://github.com/lutzroeder/netron)

### 3.1 模型输入、输出、节点、Tensor与initializer

| 名称 | 含义 | 重点记录 |
|---|---|---|
| graph input | 计算图对外接收的数据 | 名称、dtype、shape、动态维度 |
| graph output | 计算图直接返回的数据 | 名称、dtype、shape、生产节点 |
| node | 一次运算 | 算子类型、输入、输出和属性 |
| Tensor | 节点之间传递的多维数据 | shape、dtype、生产者和消费者 |
| initializer | 图中保存的常量Tensor | 权重、偏置、查找表或其他常量 |

生产者生成Tensor，消费者读取Tensor。initializer通常保存训练后的参数或固定常量，推理时直接读取。

打开模型后先记录全部输入和输出，再查看`Reshape`、`Transpose`、`Concat`、`Split`、`Gather`、`Slice`和`Resize`等改变数据组织方式的节点。卷积模型常见`Conv`，Transformer常见`MatMul`、`Softmax`和归一化操作。算子名称用于定位数据流，业务含义仍要结合源码和接口。[ONNX Python官方介绍](https://onnx.ai/onnx/intro/python)

### 3.2 从输出节点反向追踪关键计算路径

大型模型可能包含几百到几千个节点。先从每个graph output找到直接生产它的节点，再逐步查看这些节点依赖的Tensor。

```text
graph output
    ↑
任务输出层或输出投影
    ↑
主要计算模块
    ↑
输入嵌入、特征提取或前端处理
    ↑
graph input
```

分类模型可以追踪“输出层→特征模块→输入”，Transformer可以追踪“输出投影→Transformer层→embedding”，语音模型可以追踪“解码输出→编码器→波形或频谱”，检测模型则追踪任务输出和多尺度特征路径。

| Tensor名称 | 生产节点 | 消费者 | shape | dtype | 已确认含义 | 证据 |
|---|---|---|---|---|---|---|
| 按图填写 | 按图填写 | 按图填写 | 按图填写 | 按图填写 | 只写已确认语义 | 源码、节点路径或运行结果 |

自动节点名只能提供定位线索。源码模块与导出节点可能发生拆分、融合和重命名，最终要用连接关系、shape和运行结果共同核对。

### 3.3 Netron静态图无法直接确认的信息

Netron无法单独确认以下模型外约定：

- 文本分词器、词表、特殊token和最大长度。
- 音频采样率、声道、分帧和特征参数。
- 图像颜色顺序、缩放填充和归一化方式。
- 表格特征列顺序、类别编码、均值、标准差与单位。
- 动态维度在当前样本中的真实值。
- 输出字段对应的类别、单位、时间位置或业务含义。
- 生成循环、缓存更新、停止条件和采样策略的位置。

ONNX shape inference可以补充静态可推导的shape，动态行为仍可能留下未知维度。[ONNX Shape Inference说明](https://onnx.ai/onnx/repo-docs/ShapeInference.html)

---

## 4 使用PyTorch代码核对模块和运行时Tensor

PyTorch代码用于观察导出前的`nn.Module`。`named_modules()`列出模块层级，forward hook在指定模块完成`forward()`后取得本次输入和输出。这两种方法可用于卷积、Transformer、循环网络和多输入模型。

### 4.1 模型模块列表与named_modules

`named_modules()`依次返回模块路径和模块对象。模型对象应来自当前项目真实的构建与权重加载代码，因为不同项目没有统一的模型加载函数。[PyTorch nn.Module官方文档](https://docs.pytorch.org/docs/2.13/generated/torch.nn.Module.html)

```python
import torch.nn as nn


def print_module_tree(model: nn.Module, max_depth: int = 2):
    """
    model：当前项目已经创建并加载权重的PyTorch模型。
    max_depth：模块路径允许出现的点号数量，用于限制打印深度。
    输出：模块路径和模块类型。
    """
    for module_name, module in model.named_modules():
        depth = module_name.count(".") if module_name else 0

        if depth <= max_depth:
            readable_name = module_name if module_name else "<root>"
            print(readable_name, type(module).__name__)
```

`encoder.layers.0.self_attn`表示依次进入`encoder`、`layers`、第0层和`self_attn`。后续注册hook时，应从实际打印结果复制完整路径。

### 4.2 forward hook的注册、输出读取和移除

forward hook是安装在模块出口处的临时观察函数。本文启用`with_kwargs=True`，所以hook能同时看到位置参数`args`、关键字参数`kwargs`和输出`output`，适合检查多输入模型。检查完成后必须通过句柄的`remove()`移除hook。[PyTorch forward hook说明](https://docs.pytorch.org/docs/2.13/generated/torch.nn.Module.html#torch.nn.Module.register_forward_hook)

示例输入必须由当前项目的真实预处理代码产生。token编号、attention mask、音频特征和量化输入中的0都可能有特殊含义，不能统一用全0 Tensor代替。

```python
from typing import Any

import torch
import torch.nn as nn


def describe_value(value: Any):
    """递归读取Tensor或嵌套容器中的shape与dtype。"""
    if isinstance(value, torch.Tensor):
        return {"shape": tuple(value.shape), "dtype": str(value.dtype)}
    if isinstance(value, (list, tuple)):
        return [describe_value(item) for item in value]
    if isinstance(value, dict):
        return {key: describe_value(item) for key, item in value.items()}
    return type(value).__name__


def inspect_runtime_tensors(
    model: nn.Module,
    example_args: tuple,
    example_kwargs: dict,
    target_module_names: set[str],
):
    """
    model：已经加载权重的真实模型。
    example_args：传给模型的位置参数，例如(input_tensor,)。
    example_kwargs：关键字参数，例如{"attention_mask": mask}。
    target_module_names：从named_modules()结果中选出的模块路径。
    返回：模型本次forward的原始输出。
    """
    handles = []
    found_names = set()

    def make_hook(module_name):
        # 每个hook保存自己的模块名。
        def hook(module, args, kwargs, output):
            print(f"\n[{module_name}] {type(module).__name__}")
            print("args  :", describe_value(args))
            print("kwargs:", describe_value(kwargs))
            print("output:", describe_value(output))
        return hook

    for module_name, module in model.named_modules():
        if module_name in target_module_names:
            handle = module.register_forward_hook(
                make_hook(module_name),
                with_kwargs=True,
            )
            handles.append(handle)
            found_names.add(module_name)

    missing_names = target_module_names - found_names
    if missing_names:
        # 名称不匹配时停止，避免产生已经观察成功的错误结论。
        raise ValueError(f"没有找到这些模块：{missing_names}")

    model.eval()
    try:
        with torch.inference_mode():
            return model(*example_args, **example_kwargs)
    finally:
        # forward成功或失败都会移除hook，避免影响后续运行。
        for handle in handles:
            handle.remove()
```

单输入模型通常传`example_args=(input_tensor,)`；带mask的模型可以把主输入放入`example_args`，把`attention_mask`放入`example_kwargs`。先选择输入附近、一个中间模块和输出附近的模块，发现异常后再缩小观察范围。

### 4.3 PyTorch模块与ONNX节点的对应关系

PyTorch模块与ONNX节点可能形成一对多或多对一关系。一个模块可能展开成多个节点，多个推理操作也可能被融合，索引和数据变形还可能成为新的ONNX节点。

对应时依次核对：源码模块路径、hook取得的shape与dtype、Netron中的前后连接，以及固定Tensor的运行结果。节点名只用于缩小搜索范围。

---

## 5 使用ONNX与ONNX Runtime只读检查模型

ONNX Python API读取文件声明，ONNX Runtime执行模型。它们不限制输入属于图像、文本或语音；调用方只需按照接口提供名称、dtype、shape和数值语义正确的Tensor。

### 5.1 graph.input、graph.output、node与initializer

下面的脚本可用于任何ONNX模型，它只读取信息，不修改模型文件。

```python
from collections import Counter
import onnx

MODEL_PATH = "model.onnx"  # 替换为当前ONNX文件


def read_tensor_info(value_info):
    """读取一个ONNX输入或输出的名称、dtype和shape。"""
    tensor_type = value_info.type.tensor_type
    dtype_name = onnx.TensorProto.DataType.Name(tensor_type.elem_type)
    shape = []

    for dimension in tensor_type.shape.dim:
        if dimension.HasField("dim_value"):
            shape.append(dimension.dim_value)
        elif dimension.HasField("dim_param"):
            # 符号维度的真实长度由本次输入决定。
            shape.append(dimension.dim_param)
        else:
            shape.append("unknown")

    return {"name": value_info.name, "dtype": dtype_name, "shape": shape}


model = onnx.load(MODEL_PATH)
onnx.checker.check_model(model)
graph = model.graph

print("模型输入：")
for graph_input in graph.input:
    print(read_tensor_info(graph_input))

print("模型输出：")
for graph_output in graph.output:
    print(read_tensor_info(graph_output))

print("节点总数：", len(graph.node))
print("各类算子数量：", Counter(node.op_type for node in graph.node))
print("initializer数量：", len(graph.initializer))

# 从末端节点开始查看graph output的生产路径。
for node in list(graph.node)[-10:]:
    print({
        "name": node.name if node.name else "<没有节点名>",
        "op_type": node.op_type,
        "inputs": list(node.input),
        "outputs": list(node.output),
    })
```

`onnx.checker.check_model()`只验证ONNX格式和图结构是否满足规则，不负责验证输入语义、数值一致性和任务效果。

### 5.2 InferenceSession的输入输出接口与固定Tensor推理

`InferenceSession`加载并执行ONNX模型。通用检查应保存模型真正收到的Tensor，随后让所有后端复用同一份数据。本文使用NumPy的`.npz`文件保存一个或多个命名数组，键名与ONNX输入名一致。[ONNX Runtime Python入门文档](https://onnxruntime.ai/docs/get-started/with-python.html)

在真实调用程序完成预处理后，把原本要交给`session.run()`的字典保存下来：

```python
import numpy as np


def save_model_inputs(input_feed: dict[str, np.ndarray]):
    """
    input_feed：键为模型输入名，值为实际传入的NumPy数组。
    输出：sample_inputs.npz，保留每个数组的dtype和shape。
    """
    np.savez("sample_inputs.npz", **input_feed)
```

图像模型可能只有`images`；文本模型可能同时有`input_ids`和`attention_mask`；多模态模型还可能包含不同模态特征和位置编号。

```python
import numpy as np
import onnxruntime as ort

MODEL_PATH = "model.onnx"
INPUT_ARCHIVE = "sample_inputs.npz"

session = ort.InferenceSession(
    MODEL_PATH,
    providers=["CPUExecutionProvider"],
)
saved_inputs = np.load(INPUT_ARCHIVE, allow_pickle=False)
input_feed = {}

for input_meta in session.get_inputs():
    input_name = input_meta.name
    if input_name not in saved_inputs.files:
        # 缺少输入时停止；随意补0可能改变mask、token或控制量含义。
        raise KeyError(f"sample_inputs.npz缺少模型输入：{input_name}")

    input_array = np.ascontiguousarray(saved_inputs[input_name])
    input_feed[input_name] = input_array
    print({
        "name": input_name,
        "expected_type": input_meta.type,
        "declared_shape": input_meta.shape,
        "actual_dtype": str(input_array.dtype),
        "actual_shape": input_array.shape,
    })

# None表示取得全部graph output。
outputs = session.run(None, input_feed)

for output_index, output_array in enumerate(outputs):
    output_summary = {
        "output_index": output_index,
        "dtype": str(output_array.dtype),
        "shape": output_array.shape,
    }

    # 只有非空数值Tensor才计算最小值、最大值和平均值。
    # 字符串输出或长度为0的动态输出仍然可以正常打印接口信息。
    is_numeric = np.issubdtype(output_array.dtype, np.number)
    if is_numeric and output_array.size > 0:
        output_summary.update({
            "minimum": float(output_array.min()),
            "maximum": float(output_array.max()),
            "mean": float(output_array.mean()),
        })

    print(output_summary)
```

若要比较PyTorch、ONNX Runtime和部署端，应让它们接收同一份固定输入，并比较相同处理阶段、相同shape的原始输出：

```python
import numpy as np


def compare_output(reference: np.ndarray, actual: np.ndarray):
    """比较两个shape相同的浮点输出。"""
    if reference.shape != actual.shape:
        raise ValueError(
            f"shape不同：reference={reference.shape}, actual={actual.shape}"
        )

    error = np.abs(
        reference.astype(np.float64) - actual.astype(np.float64)
    )
    return {
        "max_absolute_error": float(error.max()),
        "mean_absolute_error": float(error.mean()),
    }
```

分类标签、解码文本或筛选后的检测结果已经经过任务后处理，通常不能直接与原始Tensor逐元素比较。先确认两边位于同一个模型边界。

---

## 6 模型内计算与模型外处理边界的判断方法

模型边界由graph input和graph output确定。输入到达graph input之前的操作位于模型外，graph output产生后的操作也位于模型外。某项处理是否保留在图内，要沿Netron节点路径确认。

| 模型类型 | 常见的模型外输入处理 | 需要确认的图内起点 | 常见的模型外输出处理 |
|---|---|---|---|
| 文本 | 分词、词表编号、补齐、attention mask | 输入是token编号还是embedding | token解码、停止条件、贪心或束搜索 |
| 语音 | 解码、重采样、分帧、频谱计算 | 输入是波形还是声学特征 | CTC解码、时间戳、文本整理 |
| 图像 | 解码、颜色转换、缩放、归一化 | 输入是像素还是中间特征 | 类别映射、框或掩码解码、坐标还原 |
| 表格与传感器 | 缺失值处理、编码、标准化、窗口切分 | 字段顺序、单位和窗口长度 | 反标准化、阈值与单位换算 |
| 生成模型 | 提示编码、缓存初始化、控制参数准备 | 图是否只执行一步forward | 迭代循环、缓存更新、采样和停止判断 |

判断边界使用固定顺序：

1. 在调用代码中找到原始数据怎样变成输入Tensor。
2. 在Netron中确认graph input后的第一段节点。
3. 从graph output反向追踪末端计算。
4. 在调用代码中查看谁继续消费原始输出。
5. 保存模型真实输入和原始输出，核对实际shape与dtype。

例如模型直接接收`input_ids`时，字符串分词和词表查找通常由图外分词器完成，图中的embedding节点从编号查表。语音模型直接接收梅尔频谱时，音频解码、重采样和频谱计算位于图外；模型直接接收波形且图中包含特征提取节点时，边界会更靠近原始音频。

输出也采用同样方法。分类图可能返回logits，调用代码再执行Softmax和取类别；序列模型可能只计算下一步分数，调用程序负责循环、缓存与停止条件；检测模型可能只保留部分解码。任务名称无法确定这些边界，节点路径和调用代码才是证据。

---

## 7 常见模型阅读错误及其证据核对方法

| 常见错误 | 直接后果 | 应补充的证据 |
|---|---|---|
| 只根据文件名判断结构 | 同名文件可能来自不同版本、任务或导出方式 | 来源、版本、哈希和导出记录 |
| 只记录shape，不说明维度含义 | 无法区分序列、通道、时间和特征维 | 调用代码、接口文档和固定样本 |
| 只看dtype，不确认数值语义 | `int64`可能是token或索引，`float32`也可能使用不同单位 | 预处理代码、词表、归一化参数或单位 |
| 只检查第一个输入或输出 | 会遗漏mask、缓存、控制量或辅助输出 | 遍历全部graph input与graph output |
| 把ONNX节点名直接等同源码模块 | 导出过程可能拆分、融合和重命名 | hook shape、连接路径和源码层级 |
| 给未知输入统一填0 | token、mask、长度或控制量中的0可能有特殊含义 | 保存真实调用产生的固定Tensor |
| 用业务结果对比原始Tensor | 两边处于不同处理阶段 | 比较相同边界、相同shape的输出 |
| 把ONNX格式合法视为任务正确 | checker不验证数值一致性和任务指标 | 固定输入误差与验证集指标 |
| 长期保留所有hook | 输出过多，并持续影响运行 | 选择少量节点并在`finally`中移除 |

出现不一致时，先确认文件哈希、代码版本和所有输入约定；然后比较输出数量、shape与数值；最后在输入附近、中间模块和输出附近放置少量观察点。每次只改变预处理、dtype、动态长度、执行器或导出参数中的一项。

---

## 8 YOLO11n模型阅读报告Demo

前7节的方法不依赖模型任务。本节按学习大纲选择YOLO11n做一次具体应用：收到目标检测权重后，确认输入输出、计算图边界，并检查导出的ONNX。这里的图片预处理、DFL和NMS属于YOLO11n案例，不能直接套用到文本、语音或其他模型。

### 8.1 Demo何时使用

以下情况适合执行整套检查：

- 第一次接手来自其他人的模型文件。
- PyTorch结果正常，ONNX或部署端结果异常。
- 更换Ultralytics、ONNX、ONNX Runtime或部署工具版本。
- 修改输入尺寸、动态shape、NMS等导出选项。
- 需要向RK3588等部署端说明模型的准确输入输出约定。

日常使用已经验证过的模型进行训练或推理时，不需要重复打印所有模块和节点。

### 8.2 准备目录与环境

建议建立下面的最小目录：

```text
yolo11n_reading/
├─ yolo11n.pt              # 原始PyTorch权重
├─ yolo11n.onnx            # 导出后生成
├─ demo_640.jpg             # 固定的640×640测试图片
├─ sample_inputs.npz        # 从真实图片预处理保存的固定输入Tensor
├─ export_model.py          # 固定导出参数
├─ inspect_pytorch.py       # named_modules与hook检查
├─ inspect_onnx.py          # ONNX静态接口检查
├─ compare_runtime.py       # PyTorch与ONNX固定输入比较
├─ environment.txt          # Python包版本记录
└─ reading_report.md        # 最终阅读报告
```

在PowerShell中安装本文依赖：

```powershell
# 创建仅供本Demo使用的虚拟环境
python -m venv .venv

# 激活虚拟环境
.\.venv\Scripts\Activate.ps1

# 固定Ultralytics版本；其余工具的实际安装版本会写入environment.txt
python -m pip install ultralytics==8.4.104 onnx onnxruntime pillow netron

# 保存完整环境版本，方便以后复现
python -m pip freeze > environment.txt
```

Netron也可以在Windows中通过`winget install -s winget netron`安装，或通过`pip install netron`安装Python包；具体方式见[Netron官方README](https://github.com/lutzroeder/netron)。

### 8.3 用固定参数导出YOLO11n

先解释导出参数：

- `format="onnx"`：输出ONNX格式。
- `imgsz=640`：固定示例输入高宽为640。
- `batch=1`：固定一次输入一张图片。
- `dynamic=False`：不使用动态输入shape，降低第一次阅读难度。
- `nms=False`：不把NMS加入导出模型，保留清楚的后处理边界。
- `simplify=False`：暂时不做额外图简化，便于减少一个结构变化来源。

将下面代码保存为`export_model.py`：

```python
from ultralytics import YOLO


# 权重不存在时，Ultralytics会按其机制获取官方权重。
model = YOLO("yolo11n.pt")

# 返回值是导出文件路径。
onnx_path = model.export(
    format="onnx",      # 导出为ONNX
    imgsz=640,           # 输入图片高宽
    batch=1,             # 固定batch
    dynamic=False,       # 固定shape
    nms=False,           # NMS留在模型外
    simplify=False,      # 本次不额外简化计算图
)

print("ONNX模型已导出：", onnx_path)
```

运行并记录权重哈希：

```powershell
python .\export_model.py
Get-FileHash -Algorithm SHA256 .\yolo11n.pt
Get-FileHash -Algorithm SHA256 .\yolo11n.onnx
```

### 8.4 按固定顺序完成四项检查

第一项，打开Netron：

```powershell
netron .\yolo11n.onnx
```

在Netron中记录输入、输出，并从输出反向追踪Detect相关路径、Head中的多尺度特征融合部分以及Backbone。对关键的Resize、Concat、Reshape、Transpose和Softmax节点记录前后Tensor。

第二项，把第4.1和4.2节的通用函数整理到`inspect_pytorch.py`。通过`YOLO("yolo11n.pt").model`取得本案例的`nn.Module`，先打印模块路径，再把真实图片预处理产生的Tensor作为`example_args`传入hook检查函数。目标模块名必须来自本机的`named_modules()`结果。

```powershell
python .\inspect_pytorch.py
```

第三项，把第5.1节代码保存为`inspect_onnx.py`，读取图接口、算子统计、initializer与末端节点：

```powershell
python .\inspect_onnx.py
```

第四项，在YOLO11n真实预处理完成后，把交给模型的输入字典传给第5.2节的`save_model_inputs()`。随后让PyTorch和ONNX Runtime读取同一份`sample_inputs.npz`，把固定输入比较代码保存为`compare_runtime.py`：

```powershell
python .\compare_runtime.py
```

比较结果时先看输出shape是否一致，再看最大与平均绝对误差。浮点执行顺序、算子实现和执行器不同可能带来小误差，因此不要脱离dtype、执行器和任务效果直接规定一个适用于所有模型的固定阈值。

### 8.5 整理最终阅读报告

将结果写入`reading_report.md`。下面是一份可以直接填写的模板，其中shape与字段结论针对本文固定的检测模型；节点名称、哈希和误差应填写本机真实结果。

```markdown
# YOLO11n模型阅读报告

## 1. 模型身份

- 来源：Ultralytics官方包
- 版本：ultralytics==8.4.104
- 任务：目标检测
- PyTorch权重：yolo11n.pt
- ONNX模型：yolo11n.onnx
- 两个文件的SHA-256：填写Get-FileHash结果
- 导出设置：imgsz=640、batch=1、dynamic=False、nms=False

## 2. 输入约定

- 输入名称：填写InferenceSession结果
- dtype：float32
- layout：NCHW
- shape：1×3×640×640
- 颜色顺序：RGB
- 数值处理：uint8像素转换为float32后除以255
- 任意尺寸图片：应复用实际调用代码的letterbox

## 3. 输出约定

- 输出数量：填写实际结果
- 第一个输出shape：本文固定条件下应核对是否为1×84×8400
- 84个字段：4个框值 + 80个类别分数
- 8400个候选位置：80×80 + 40×40 + 20×20
- 输出坐标所对应的输入尺度：根据运行代码和图中解码路径确认

## 4. 关键路径

- graph input → Backbone：填写关键节点或Tensor名
- Backbone → Head中的特征融合部分：填写三条尺度路径
- 多尺度特征 → Detect：填写对应节点或Tensor名
- Detect → graph output：填写Concat、DFL投影和坐标计算路径

## 5. 处理边界

- RGB转换、letterbox、除以255、HWC转NCHW：模型外
- DFL分布投影与框解码：根据Netron路径和4字段输出确认
- 阈值筛选与NMS：模型外，因为导出时nms=False
- 坐标映射回原图：模型外

## 6. PyTorch与ONNX对比

- PyTorch输出shape：填写脚本输出
- ONNX输出shape：填写脚本输出
- 最大绝对误差：填写脚本输出
- 平均绝对误差：填写脚本输出
- 执行设备与dtype：CPU、float32

## 7. 三个待验证问题

1. 当前ONNX末端各节点与PyTorch Detect内部操作如何逐项对应？
2. 更换ONNX Runtime执行器后，数值误差和耗时如何变化？
3. 转换为RKNN后，哪些解码步骤仍在图内，哪些被移动到CPU后处理？
```

报告中应把“已确认结论”和“待验证问题”分开。暂时无法确认的节点含义可以保留，不要为了让报告看起来完整而补写没有证据的结论。

### 8.6 扩展：与RK3588示例模型比较

这一项只在准备RK3588部署时使用，不属于第一次阅读YOLO11n的必做步骤。

拿到RKNN示例模型后，重新记录它的仓库提交、转换脚本、量化设置、输入dtype和输出接口，再与本文ONNX报告对照：

| 对比项 | Ultralytics ONNX | RK3588示例模型 |
|---|---|---|
| 输入dtype与layout | 从ORT接口填写 | 从RKNN初始化和推理代码填写 |
| 输入量化 | float32、0～1 | 根据转换配置与API确认 |
| 输出数量与shape | 从ORT实际运行填写 | 从RKNN实际运行填写 |
| DFL解码位置 | 从Netron末端路径确认 | 从模型输出与C/C++后处理确认 |
| NMS位置 | 本文导出位于模型外 | 从示例后处理代码确认 |

部分RK3588示例为了方便量化或加速，会让模型直接输出多个尺度的特征，再由CPU端代码执行DFL解码和NMS；另一些转换产物可能保留更多图内计算。具体结论必须来自所选仓库版本、转换脚本和实际输出，不能套用其他示例的shape。

---

这套方法可以直接迁移到分类、回归、文本、语音、生成和多模态模型。更换模型后，需要替换具体输入语义、模块名称和任务后处理；来源记录、接口核对、反向追踪、hook观察与固定Tensor验证的顺序保持不变。
