---
title: '[嵌入式AI-推理部署] PythonONNXRuntime推理与数值基线'
published: 2026-09-24T08:30:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍PythonONNXRuntime推理与数值基线的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-3 Python ONNX Runtime推理与数值基线

Python调用ONNX模型的必需流程只有四步：创建推理会话、读取模型输入输出接口、传入NumPy数组、取得模型输出。ONNX模型可以处理图像、文本、语音和普通数值张量，ONNX Runtime只执行模型计算图。具体数据代表什么，以及怎样解释模型输出，由模型本身的接口约定决定。

```text
model.onnx
    ↓ InferenceSession加载
读取输入名称、形状、类型和输出名称
    ↓
按照输入名称传入NumPy数组
    ↓ session.run()
取得一个或多个原始输出
```

数值基线属于可选检测流程，用于检查导出前后的计算结果有没有发生异常变化。普通推理程序不需要每次执行这项检测。第3节会单独说明它的目的和用法。

## 1 Python使用ONNX模型的必需流程与API参数

### 1.1 安装ONNX Runtime

ONNX Runtime是执行ONNX模型的推理引擎。Python程序使用`onnxruntime`包创建推理会话，使用NumPy数组传入和接收张量。

CPU版本安装命令为：

```bash
python -m pip install numpy onnxruntime
```

需要使用NVIDIA GPU时安装`onnxruntime-gpu`。同一个Python环境只保留`onnxruntime`或`onnxruntime-gpu`中的一个。官方当前安装方法见[ONNX Runtime Python入门文档](https://onnxruntime.ai/docs/get-started/with-python.html)。

```python
import numpy as np
import onnxruntime as ort
```

阶段4-2使用的`onnx`包负责读取和检查模型结构。本节执行模型使用`onnxruntime`。

### 1.2 `InferenceSession()`加载模型及其参数

`InferenceSession`是ONNX Runtime的推理会话类。构造函数的主要形式为：

```python
ort.InferenceSession(
    path_or_bytes,
    sess_options=None,
    providers=None,
    provider_options=None,
    **kwargs,
)
```

各参数的作用如下：

| 参数 | 作用 | 常用取值与注意事项 |
| --- | --- | --- |
| `path_or_bytes` | 指定要加载的模型 | 可以传ONNX文件路径、`PathLike`对象或模型的二进制内容。最常用的是`"model.onnx"`。 |
| `sess_options` | 指定推理会话配置 | 接收`ort.SessionOptions`对象。普通推理可以保留`None`。需要调整日志、线程数或图优化配置时再创建该对象。 |
| `providers` | 指定执行后端及优先顺序 | 传字符串列表，例如`["CPUExecutionProvider"]`。列表前面的执行后端优先使用。 |
| `provider_options` | 给`providers`中的执行后端传专用配置 | 它是字典列表，位置与`providers`一一对应。只使用默认配置时传`None`。 |
| `**kwargs` | ONNX Runtime预留的额外关键字参数 | 普通推理不要自行填写。只有对应版本的官方文档明确要求时才使用。 |

执行后端（Execution Provider）负责在指定硬件上实现和运行ONNX算子。CPU基线使用：

```python
from pathlib import Path

import onnxruntime as ort


model_path = Path("model.onnx")
if not model_path.is_file():
    raise FileNotFoundError(f"找不到ONNX模型：{model_path.resolve()}")

session = ort.InferenceSession(
    path_or_bytes=str(model_path),
    sess_options=None,
    providers=["CPUExecutionProvider"],
    provider_options=None,
)
```

这段代码只完成模型加载。创建成功后，`session`保存已经准备好的模型执行状态，同一个对象可以执行多次推理。

当某个执行后端需要参数时，可以使用下面两种写法中的一种：

```python
# 写法一：providers只写名称，provider_options按相同位置提供配置。
session = ort.InferenceSession(
    "model.onnx",
    providers=["CUDAExecutionProvider", "CPUExecutionProvider"],
    provider_options=[
        {"device_id": "0"},  # 对应CUDAExecutionProvider
        {},                  # 对应CPUExecutionProvider
    ],
)

# 写法二：把名称和配置写成元组。
session = ort.InferenceSession(
    "model.onnx",
    providers=[
        ("CUDAExecutionProvider", {"device_id": "0"}),
        "CPUExecutionProvider",
    ],
)
```

两种写法不要混合使用。本文后面的代码只使用CPU默认配置。`InferenceSession`的当前参数定义见[ONNX Runtime Python API](https://onnxruntime.ai/docs/api/python/api_summary.html#onnxruntime.InferenceSession)。

### 1.3 获取执行后端与输入输出信息的API

模型加载完成后，最常用的查询API有四个：

| API | 参数 | 返回值 | 用途 |
| --- | --- | --- | --- |
| `ort.get_available_providers()` | 无 | 当前Python环境可用的执行后端名称列表 | 创建会话前确认本机能使用哪些后端。 |
| `session.get_providers()` | 无 | 当前会话已经注册的执行后端列表 | 确认这个模型会话实际启用了哪些后端。 |
| `session.get_inputs()` | 无 | 输入`NodeArg`对象列表 | 获取每个输入的名称、形状和元素类型。 |
| `session.get_outputs()` | 无 | 输出`NodeArg`对象列表 | 获取每个输出的名称、形状和元素类型。 |

`NodeArg`表示模型的一个输入或输出接口。本文会使用它的三个属性：

- `name`：输入或输出名称。
- `shape`：张量形状，例如`[1, 8]`或`["batch", 8]`。
- `type`：元素类型，例如`tensor(float)`。

```python
print("当前环境可用后端：", ort.get_available_providers())
print("当前会话启用后端：", session.get_providers())

input_infos = session.get_inputs()
output_infos = session.get_outputs()

print("模型输入：")
for info in input_infos:
    print(f"  name={info.name}, shape={info.shape}, type={info.type}")

print("模型输出：")
for info in output_infos:
    print(f"  name={info.name}, shape={info.shape}, type={info.type}")
```

程序必须使用当前模型返回的`name`。文件名相似的两个模型也可能使用不同的输入输出名称。

`shape`中的整数表示固定维度。`None`或字符串表示动态维度，例如`["batch", 8]`允许本次传入`[1,8]`，下次传入`[4,8]`。每次传入的数组仍要包含批量维度。

### 1.4 `session.run()`执行推理及其参数

`session.run()`执行一次同步推理。函数形式为：

```python
session.run(
    output_names,
    input_feed,
    run_options=None,
)
```

三个参数的含义如下：

| 参数 | 作用 | 常用写法 |
| --- | --- | --- |
| `output_names` | 指定本次需要返回哪些图输出 | 传`None`取得全部输出；传`["output_a", "output_b"]`只取得指定输出。名称必须来自`get_outputs()`。 |
| `input_feed` | 给每个模型输入提供数据 | 传`{输入名称: 输入值}`字典。CPU普通张量一般直接使用NumPy数组。多输入模型要提供全部必需输入。 |
| `run_options` | 设置本次调用专用的运行配置 | 接收`ort.RunOptions`。普通同步推理使用`None`。它不负责配置模型加载或执行后端。 |

返回值是列表，元素顺序与`output_names`的顺序一致。`output_names=None`时，顺序与`session.get_outputs()`一致。普通张量输出在CPU上表现为NumPy数组；ONNX序列或映射类型可能返回Python列表或字典。官方接口定义见[`InferenceSession.run()`文档](https://onnxruntime.ai/docs/api/python/api_summary.html#onnxruntime.InferenceSession.run)。

一个单输入模型的完整调用为：

```python
input_info = session.get_inputs()[0]

# 这个示例假设model.onnx要求形状[1, 8]的32位浮点数。
# 实际形状和类型以input_info.shape、input_info.type为准。
input_tensor = np.ones((1, 8), dtype=np.float32)

outputs = session.run(
    output_names=None,
    input_feed={input_info.name: input_tensor},
    run_options=None,
)

for index, output in enumerate(outputs):
    print(f"输出{index}：shape={output.shape}, dtype={output.dtype}")
```

正常推理流程到这里已经完成。程序接下来怎样解释`outputs`，由具体模型的输出协议决定。

## 2 单输入、多输入和多输出模型的统一调用方式

### 2.1 单输入单输出模型

单输入单输出模型仍然返回列表。指定一个输出名称后，通过`[0]`取得对应结果：

```python
input_name = session.get_inputs()[0].name
output_name = session.get_outputs()[0].name

result = session.run(
    output_names=[output_name],
    input_feed={input_name: input_tensor},
    run_options=None,
)[0]
```

这里的`[output_name]`是“请求的输出名称列表”，末尾的`[0]`是“从返回列表中取第一个结果”。

### 2.2 多输入模型

多输入模型通过同一个`input_feed`字典传入全部输入：

```python
input_infos = session.get_inputs()

left_tensor = np.ones((1, 4), dtype=np.float32)
right_tensor = np.full((1, 4), 2.0, dtype=np.float32)

input_feed = {
    input_infos[0].name: left_tensor,
    input_infos[1].name: right_tensor,
}

outputs = session.run(
    output_names=None,
    input_feed=input_feed,
    run_options=None,
)
```

ONNX Runtime按照字典中的名称匹配输入。字典书写顺序不负责建立对应关系。缺少必需输入、输入名称错误、形状错误或元素类型错误时，本次`run()`会失败并抛出异常。

### 2.3 多输出模型

多输出模型可以取得全部输出，也可以只取得当前程序需要的输出。

取得全部输出：

```python
output_infos = session.get_outputs()
output_values = session.run(None, input_feed)

# get_outputs()与run(None, ...)使用相同的图输出顺序。
output_map = {
    info.name: value
    for info, value in zip(output_infos, output_values)
}
```

只取得指定输出：

```python
selected_names = [
    session.get_outputs()[0].name,
    session.get_outputs()[2].name,
]

selected_outputs = session.run(
    output_names=selected_names,
    input_feed=input_feed,
)
```

`selected_outputs[0]`对应`selected_names[0]`，`selected_outputs[1]`对应`selected_names[1]`。模型有多个输出时，先打印名称和形状，再确定每个输出的业务含义。

## 3 可选检测流程：数值基线

### 3.1 数值基线用于检测什么

数值基线是一份用来对照的参考结果。模型还在PyTorch中时，使用固定输入保存一份原始输出；模型导出ONNX后，再把完全相同的输入交给ONNX Runtime。两份输出的差值可以检查导出过程是否明显改变了计算结果。

它主要用于下面几种情况：

- 第一次导出模型，需要确认ONNX结果与原模型一致。
- 修改了导出参数、算子集版本或模型结构。
- 更换了ONNX Runtime版本或执行后端。
- 模型能够运行，但最终结果明显异常，需要判断问题发生在模型计算还是后处理。

普通业务推理不需要每次执行这项检测。部署程序确认模型版本稳定后，可以只保留正常的`session.run()`流程。

数值基线的检测路径为：

```text
同一个固定输入
    ├── 原框架计算 → 参考输出
    └── ONNX Runtime计算 → ONNX输出
                         ↓
                  比较同一阶段的原始张量
```

### 3.2 最大绝对误差与平均绝对误差

设参考输出为$R$，ONNX Runtime输出为$O$。最大绝对误差为：

$$
E_{\max}=\max_i|R_i-O_i|
$$

它表示所有对应元素中最大的差值。

平均绝对误差为：

$$
E_{\text{mean}}=\frac{1}{N}\sum_{i=1}^{N}|R_i-O_i|
$$

其中$N$是输出元素总数。它表示整体的平均差值。

```python
reference_output = np.load("reference_output.npy")
onnx_output = outputs[0]

if reference_output.shape != onnx_output.shape:
    raise ValueError(
        f"无法逐元素比较：reference={reference_output.shape}, "
        f"onnx={onnx_output.shape}"
    )

absolute_difference = np.abs(reference_output - onnx_output)
print("最大绝对误差：", absolute_difference.max())
print("平均绝对误差：", absolute_difference.mean())
```

比较成立需要三个前提：

1. 两边使用完全相同的输入数组。
2. 两边加载同一份模型参数。
3. 两边比较同一计算阶段、相同形状和相同含义的输出。

检测框或分类标签已经经过阈值筛选等后续操作，只能作为补充观察。数值基线比较的是后处理之前的原始输出。

## 4 Python调用ONNX时的常见错误

### 4.1 输入名称、形状或元素类型错误

输入字典的键与模型输入名称不同，会出现“缺少输入”或“输入名称无效”一类错误。数组维度或元素类型不符合模型接口时，ONNX Runtime会报告实际值与期望值不匹配。

先打印模型要求和实际数组：

```python
input_info = session.get_inputs()[0]

print("模型输入名称：", input_info.name)
print("模型要求形状：", input_info.shape)
print("模型要求类型：", input_info.type)
print("实际数组形状：", input_tensor.shape)
print("实际数组类型：", input_tensor.dtype)
```

修正时使用`input_info.name`建立输入字典，并按照当前模型接口生成数组。动态维度可以改变长度，但不能从数组中省略。

### 4.2 模型或执行后端加载失败

文件路径错误、模型损坏、算子不受支持或算子集版本不兼容，都可能导致`InferenceSession`创建失败。模型加载阶段已经失败时，后面的`session.run()`不会执行。

请求GPU后端前先检查当前环境：

```python
print(ort.get_available_providers())
```

列表中没有`CUDAExecutionProvider`时，当前Python环境无法按该名称创建CUDA会话。排查CPU基线时明确使用`providers=["CPUExecutionProvider"]`。

## 5 瑞芯微优化YOLO11 ONNX的九个输出与后处理函数

### 5.1 九个输出为什么需要外部后处理

本节Demo使用瑞芯微`rknn_model_zoo`配套导出的优化YOLO11 ONNX。它保留三个检测尺度，每个尺度输出三个张量，共九个输出：

| 检测尺度 | 边框距离分布 | 类别置信度 | 类别置信度之和 |
| --- | --- | --- | --- |
| 80×80 | `[1,64,80,80]` | `[1,80,80,80]` | `[1,1,80,80]` |
| 40×40 | `[1,64,40,40]` | `[1,80,40,40]` | `[1,1,40,40]` |
| 20×20 | `[1,64,20,20]` | `[1,80,20,20]` | `[1,1,20,20]` |

模型输出顺序按三个尺度排列：

```text
0  80×80边框分布
1  80×80类别置信度
2  80×80类别置信度之和
3  40×40边框分布
4  40×40类别置信度
5  40×40类别置信度之和
6  20×20边框分布
7  20×20类别置信度
8  20×20类别置信度之和
```

瑞芯微把边框解码、候选框筛选和非极大值抑制移到模型外部，所以`session.run()`只返回原始张量。Python程序必须继续执行后处理，才能得到最终检测框。RKNN Model Zoo说明了九个输出的含义及图结构调整：[YOLO11优化模型说明](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/README.md#3-pretrained-model)。

仓库当前Python后处理使用第0、1、3、4、6、7项，忽略三个“类别置信度之和”输出。这与官方`yolo11.py`实现一致：[RKNN Model Zoo YOLO11 Python源码](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/python/yolo11.py)。

### 5.2 `softmax()`与`dfl()`解码边框距离分布

64个边框通道分成左、上、右、下四组，每组16个数。这16个数表示距离落在0到15各位置的相对可能性。

`softmax(values, axis)`有两个参数：

- `values`：需要转换的NumPy数组。
- `axis`：在哪个维度上计算概率。DFL在16个离散位置所在的维度计算，所以使用`axis=2`。

它返回与`values`形状相同的概率数组，同一组16个概率之和为1。

`dfl(position)`有一个参数：

- `position`：形状为`[1,64,H,W]`的边框分布张量。

它返回`[1,4,H,W]`，四个通道依次表示左、上、右、下距离。每个距离通过16个位置的概率加权求和得到：

$$
d=\sum_{k=0}^{15}p_k k
$$

其中$p_k$是第$k$个离散位置的概率。

### 5.3 `decode_boxes()`把距离转换成输入图坐标

`decode_boxes(position, input_size)`接收：

- `position`：当前尺度的`[1,64,H,W]`边框分布。
- `input_size`：模型输入大小，格式为`(height, width)`，本Demo使用`(640,640)`。

函数先建立$H\times W$网格，再调用`dfl()`取得每个网格点到四条边的距离。当前网格点中心为$(x+0.5,y+0.5)$，边框坐标为：

$$
x_1=(x+0.5-l)s_x
$$

$$
y_1=(y+0.5-t)s_y
$$

$$
x_2=(x+0.5+r)s_x
$$

$$
y_2=(y+0.5+b)s_y
$$

$l,t,r,b$分别是左、上、右、下距离，$s_x$和$s_y$是当前特征图相对输入图的横向和纵向步长。函数返回`[1,4,H,W]`，坐标顺序为$(x_1,y_1,x_2,y_2)$。

### 5.4 `flatten_feature()`与`filter_boxes()`整理和筛选候选框

`flatten_feature(feature)`接收`[1,C,H,W]`张量，先转换为`[1,H,W,C]`，再展平为`[H\times W,C]`。这样每一行对应一个网格位置。

`filter_boxes(boxes, class_probabilities, threshold)`接收：

- `boxes`：形状为`[候选框数量,4]`的边框。
- `class_probabilities`：形状为`[候选框数量,类别数量]`的类别置信度。
- `threshold`：最低置信度阈值。

函数为每个候选框找到最高类别置信度及其类别编号，删除低于`threshold`的候选框，返回筛选后的边框、类别和置信度。

瑞芯微优化YOLO11输出的类别张量已经包含类别置信度。当前Python流程不再乘一个独立的目标置信度。

### 5.5 `nms_boxes()`删除同类别重复框

非极大值抑制（Non-Maximum Suppression，NMS）用于删除指向同一目标的高度重叠候选框。

`nms_boxes(boxes, scores, iou_threshold)`接收：

- `boxes`：同一个类别的边框，格式为$(x_1,y_1,x_2,y_2)$。
- `scores`：每个边框的置信度。
- `iou_threshold`：交并比阈值，本Demo使用0.45。

函数先保留最高分边框，再计算它与其余边框的交并比（Intersection over Union，IoU）。IoU高于阈值的框被删除，剩余框继续执行相同步骤。函数返回需要保留的边框索引。

### 5.6 `post_process()`组织完整后处理

`post_process(outputs, input_size, confidence_threshold, iou_threshold)`接收`session.run()`返回的九个输出。

它按照以下顺序工作：

```text
分别读取80×80、40×40、20×20分支
→ decode_boxes()解码三个尺度的边框
→ flatten_feature()把网格位置展平
→ 合并三个尺度
→ filter_boxes()执行置信度筛选
→ 按类别分别调用nms_boxes()
→ 返回最终boxes、class_ids、scores
```

这一函数是后处理的总入口。下一节的整体推理程序只需把九个原始输出交给它。

下面把全部后处理函数单独保存为`yolo11_postprocess.py`：

```python
import numpy as np


def softmax(values: np.ndarray, axis: int) -> np.ndarray:
    """
    在axis指定的维度上计算Softmax。

    参数：
        values：输入数组。
        axis：需要归一化的维度。
    返回：
        与values形状相同的概率数组。
    """
    # 先减去最大值，防止指数运算产生过大的浮点数。
    shifted = values - np.max(values, axis=axis, keepdims=True)
    exponentials = np.exp(shifted)

    # keepdims=True保留被归一化的维度，使分母可以与原数组直接广播相除。
    return exponentials / np.sum(exponentials, axis=axis, keepdims=True)


def dfl(position: np.ndarray) -> np.ndarray:
    """
    把[batch, 64, H, W]的边框分布解码为[batch, 4, H, W]距离。

    64个通道分成左、上、右、下四组，每组离散位置数量由输入通道数计算。
    """
    # position的每个网格位置都有64个数：4个方向，每个方向16个离散距离。
    batch, channels, height, width = position.shape
    direction_count = 4

    if channels % direction_count != 0:
        raise ValueError(f"边框通道数不能分成四组：{channels}")

    bin_count = channels // direction_count

    # 拆分后五个维度依次表示：批量、方向、离散距离、特征图高、特征图宽。
    distribution = position.reshape(
        batch,
        direction_count,
        bin_count,
        height,
        width,
    )
    # 只在离散距离维上做Softmax，每个方向的16个概率之和为1。
    probabilities = softmax(distribution, axis=2)

    bin_positions = np.arange(bin_count, dtype=np.float32).reshape(
        1,
        1,
        bin_count,
        1,
        1,
    )
    # 概率乘距离编号后求和，得到该方向最终采用的浮点距离。
    return np.sum(probabilities * bin_positions, axis=2)


def decode_boxes(
    position: np.ndarray,
    input_size: tuple,
) -> np.ndarray:
    """
    把一个检测尺度的DFL距离转换成模型输入图上的xyxy坐标。

    参数：
        position：[batch, 64, H, W]边框分布。
        input_size：(输入高度, 输入宽度)。
    返回：
        [batch, 4, H, W]边框，四个通道为x1、y1、x2、y2。
    """
    input_height, input_width = input_size
    grid_height, grid_width = position.shape[2:4]

    # 为特征图上的每个位置建立网格坐标，例如80×80分支会建立6400个网格点。
    grid_x, grid_y = np.meshgrid(
        np.arange(grid_width, dtype=np.float32),
        np.arange(grid_height, dtype=np.float32),
    )
    grid = np.stack((grid_x, grid_y), axis=0).reshape(
        1,
        2,
        grid_height,
        grid_width,
    )

    # distances的四个通道依次表示左、上、右、下距离，单位还是特征图网格。
    distances = dfl(position)
    top_left = grid + 0.5 - distances[:, 0:2]
    bottom_right = grid + 0.5 + distances[:, 2:4]
    boxes = np.concatenate((top_left, bottom_right), axis=1)

    # 将特征图网格坐标乘以步长，转换成640×640模型输入图上的像素坐标。
    stride_x = input_width / grid_width
    stride_y = input_height / grid_height
    strides = np.array(
        [stride_x, stride_y, stride_x, stride_y],
        dtype=np.float32,
    ).reshape(1, 4, 1, 1)

    return boxes * strides


def flatten_feature(feature: np.ndarray) -> np.ndarray:
    """
    把[1, C, H, W]转换成[H*W, C]，使每一行对应一个候选位置。
    """
    if feature.shape[0] != 1:
        raise ValueError("本Demo的后处理只支持batch=1")

    channels = feature.shape[1]

    # transpose把通道放到最后；reshape再把所有网格位置排成候选框列表。
    # 例如[1, 4, 80, 80]最终变成[6400, 4]。
    return feature.transpose(0, 2, 3, 1).reshape(-1, channels)


def filter_boxes(
    boxes: np.ndarray,
    class_probabilities: np.ndarray,
    threshold: float,
):
    """
    保留最高类别置信度不低于threshold的候选框。

    返回：
        filtered_boxes：[N, 4]边框。
        class_ids：[N]类别编号。
        scores：[N]最高类别置信度。
    """
    # 每个候选框只保留分数最高的类别及其分数。
    class_ids = np.argmax(class_probabilities, axis=1)
    scores = np.max(class_probabilities, axis=1)

    # accepted是布尔掩码；三个返回数组使用同一掩码，所以行仍然一一对应。
    accepted = scores >= threshold

    return boxes[accepted], class_ids[accepted], scores[accepted]


def nms_boxes(
    boxes: np.ndarray,
    scores: np.ndarray,
    iou_threshold: float,
) -> np.ndarray:
    """
    对同一个类别执行NMS，返回保留框在当前boxes中的索引。
    """
    if len(boxes) == 0:
        return np.empty((0,), dtype=np.int64)

    x1 = boxes[:, 0]
    y1 = boxes[:, 1]
    x2 = boxes[:, 2]
    y2 = boxes[:, 3]
    areas = np.maximum(0.0, x2 - x1) * np.maximum(0.0, y2 - y1)

    # 分数从高到低排列，保证每轮先保留当前置信度最高的框。
    order = np.argsort(scores)[::-1]
    kept_indices = []

    while order.size > 0:
        current = int(order[0])
        kept_indices.append(current)

        # remaining只包含尚未决定保留或删除的框。
        remaining = order[1:]
        intersection_x1 = np.maximum(x1[current], x1[remaining])
        intersection_y1 = np.maximum(y1[current], y1[remaining])
        intersection_x2 = np.minimum(x2[current], x2[remaining])
        intersection_y2 = np.minimum(y2[current], y2[remaining])

        intersection_width = np.maximum(
            0.0,
            intersection_x2 - intersection_x1,
        )
        intersection_height = np.maximum(
            0.0,
            intersection_y2 - intersection_y1,
        )
        intersection_area = intersection_width * intersection_height

        # IoU = 交集面积 / 并集面积；并集为0时把IoU写成0，避免除零。
        union_area = areas[current] + areas[remaining] - intersection_area
        iou = np.divide(
            intersection_area,
            union_area,
            out=np.zeros_like(intersection_area),
            where=union_area > 0,
        )

        # IoU不高于阈值的框进入下一轮；重叠过高的框在这里删除。
        order = remaining[iou <= iou_threshold]

    return np.asarray(kept_indices, dtype=np.int64)


def post_process(
    outputs: list,
    input_size: tuple,
    confidence_threshold: float = 0.25,
    iou_threshold: float = 0.45,
):
    """
    处理瑞芯微优化YOLO11的九个输出。

    参数：
        outputs：session.run()按模型输出顺序返回的九个数组。
        input_size：(输入高度, 输入宽度)。
        confidence_threshold：最低类别置信度。
        iou_threshold：同类别NMS的IoU阈值。
    返回：
        boxes：[N, 4]，模型输入图坐标。
        class_ids：[N]，类别编号。
        scores：[N]，类别置信度。
    """
    # 先挡住最常见的模型不匹配：官方单输出ONNX不能进入这套九输出后处理。
    if len(outputs) != 9:
        raise ValueError(f"优化YOLO11应返回9个输出，实际为{len(outputs)}个")

    # 这两个列表暂存三个检测尺度解码后的结果，循环结束后再统一拼接。
    all_boxes = []
    all_class_probabilities = []

    # 三个分支按80×80、40×40、20×20排列，起始索引分别为0、3、6。
    # 每个分支连续放置：边框分布、类别置信度、score_sum。
    # 当前Python后处理使用前两项；第三个score_sum输出留给其他快速筛选实现使用。
    for branch_start in (0, 3, 6):
        # 取出的形状分别为[1, 64, H, W]和[1, 类别数, H, W]。
        box_distribution = outputs[branch_start]
        class_probabilities = outputs[branch_start + 1]

        # 先把64通道边框分布解码成xyxy坐标，再把H×W网格展平成候选框列表。
        decoded_boxes = decode_boxes(box_distribution, input_size)
        all_boxes.append(flatten_feature(decoded_boxes))
        all_class_probabilities.append(
            flatten_feature(class_probabilities)
        )

    # 三个尺度在候选框维拼接。640输入时数量为6400+1600+400=8400。
    boxes = np.concatenate(all_boxes, axis=0)
    class_probabilities = np.concatenate(
        all_class_probabilities,
        axis=0,
    )

    # 阈值筛选后三个数组长度相同：第i个框、类别和分数描述同一个候选目标。
    boxes, class_ids, scores = filter_boxes(
        boxes,
        class_probabilities,
        confidence_threshold,
    )

    # 下面三个列表只保存各类别经过NMS后最终保留的结果。
    final_class_ids = []
    final_scores = []
    final_boxes = []

    # 不同类别分别执行NMS，避免一个类别的框删除另一个类别的框。
    for class_id in np.unique(class_ids):
        # class_mask从全部候选框中选出当前类别，class_boxes与class_scores继续一一对应。
        class_mask = class_ids == class_id
        class_boxes = boxes[class_mask]
        class_scores = scores[class_mask]

        # kept中的索引相对于当前class_boxes，不能直接用于原始boxes。
        kept = nms_boxes(
            class_boxes,
            class_scores,
            iou_threshold,
        )

        final_boxes.append(class_boxes[kept])

        # NMS返回的是索引，所以这里重新建立与保留框数量相同的类别编号数组。
        final_class_ids.append(
            np.full(len(kept), class_id, dtype=np.int64)
        )
        final_scores.append(class_scores[kept])

    # 没有候选框通过阈值或NMS时，返回形状明确的空数组，调用者可以继续统一处理。
    if not final_boxes:
        return (
            np.empty((0, 4), dtype=np.float32),
            np.empty((0,), dtype=np.int64),
            np.empty((0,), dtype=np.float32),
        )

    # 各类别此前分开执行NMS，现在重新合并成最终输出。
    return (
        np.concatenate(final_boxes, axis=0),
        np.concatenate(final_class_ids, axis=0),
        np.concatenate(final_scores, axis=0),
    )


def scale_boxes_to_original(
    boxes: np.ndarray,
    scale: float,
    pad_left: int,
    pad_top: int,
    original_width: int,
    original_height: int,
) -> np.ndarray:
    """
    把模型输入图坐标还原到原图坐标，并限制在原图边界内。
    """
    # 使用副本保护post_process()返回的模型输入图坐标，避免调用后被原地改写。
    restored = boxes.copy()

    # 模型输入图坐标先减去左/上补边，再除以缩放比例，得到原图像素坐标。
    restored[:, [0, 2]] = (
        restored[:, [0, 2]] - pad_left
    ) / scale
    restored[:, [1, 3]] = (
        restored[:, [1, 3]] - pad_top
    ) / scale

    # 裁剪到原图边界，防止绘图或后续裁剪访问图像范围之外的位置。
    restored[:, [0, 2]] = np.clip(
        restored[:, [0, 2]],
        0,
        original_width - 1,
    )
    restored[:, [1, 3]] = np.clip(
        restored[:, [1, 3]],
        0,
        original_height - 1,
    )
    return restored
```

这份文件只负责把九个原始输出转换成检测框。它不创建`InferenceSession`，也不调用ONNX模型。这样可以清楚地区分“ONNX Runtime执行模型”和“Python解释模型输出”两个阶段。

## 6 瑞芯微优化YOLO11 ONNX完整推理Demo

### 6.1 Demo文件与运行条件

准备以下文件：

```text
yolo11_onnx_demo/
├── yolo11n.onnx
├── test.jpg
├── yolo11_postprocess.py
└── infer_yolo11_onnx.py
```

其中`yolo11n.onnx`必须是前面通过瑞芯微配套导出流程得到的九输出模型。安装依赖：

```bash
python -m pip install numpy onnxruntime opencv-python
```

整体流程为：

```text
读取图片并缩放补边
→ 转成模型要求的NumPy输入
→ InferenceSession加载九输出ONNX
→ session.run()执行模型
→ 得到九个原始输出
→ post_process()完成外部后处理
→ 坐标还原并保存结果图片
```

这里最需要观察的是中间三行：`InferenceSession`负责加载ONNX，`session.run()`负责执行ONNX，返回值是九个原始数组。后处理在模型执行结束后才开始。

### 6.2 图片预处理函数

`letterbox(image, target_height, target_width)`接收OpenCV读取的BGR图片和模型输入高宽。它返回：

- `input_tensor`：形状`[1,3,H,W]`的32位浮点数数组。
- `scale`：原图缩放到模型输入图时使用的比例。
- `pad_left`：左侧填充像素数。
- `pad_top`：顶部填充像素数。

瑞芯微当前YOLO11 Python示例使用黑色填充、BGR转RGB、HWC转CHW，并把像素值除以255。仓库原始执行流程可参考[`yolo11.py`](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/python/yolo11.py)。

### 6.3 ONNX加载、执行与后处理的整体代码

将下面代码保存为`infer_yolo11_onnx.py`：

```python
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

from yolo11_postprocess import post_process
from yolo11_postprocess import scale_boxes_to_original


MODEL_PATH = Path("yolo11n.onnx")
IMAGE_PATH = Path("test.jpg")
RESULT_PATH = Path("result.jpg")
DEFAULT_INPUT_SIZE = (640, 640)  # (height, width)


def letterbox(
    image: np.ndarray,
    target_height: int,
    target_width: int,
):
    """
    等比例缩放并使用黑色补边，再生成YOLO11 ONNX需要的输入数组。

    返回：
        input_tensor：[1, 3, target_height, target_width]、float32、RGB、0～1。
        scale：原图到模型输入图的缩放比例。
        pad_left、pad_top：坐标还原时需要减去的填充量，单位为像素。
    """
    # OpenCV图像形状为[高度, 宽度, 通道]，这里只读取原图高宽。
    original_height, original_width = image.shape[:2]

    # 取横向和纵向缩放比例中的较小值，保证整张原图都能放进目标画布。
    scale = min(
        target_width / original_width,
        target_height / original_height,
    )

    # 缩放后图像保持原宽高比，剩余区域稍后用黑色填充。
    resized_width = round(original_width * scale)
    resized_height = round(original_height * scale)
    resized = cv2.resize(
        image,
        (resized_width, resized_height),
        interpolation=cv2.INTER_LINEAR,
    )

    # 左右、上下居中放置。若总填充量为奇数，多出的1像素留在右侧或底部。
    pad_left = (target_width - resized_width) // 2
    pad_top = (target_height - resized_height) // 2

    # 先建立全黑目标画布，再把缩放图复制到指定区域。
    padded = np.zeros(
        (target_height, target_width, 3),
        dtype=np.uint8,
    )
    padded[
        pad_top:pad_top + resized_height,
        pad_left:pad_left + resized_width,
    ] = resized

    # OpenCV读取结果为BGR；模型需要RGB，所以交换第一和第三个颜色通道。
    rgb = cv2.cvtColor(padded, cv2.COLOR_BGR2RGB)

    # HWC转CHW后，三个通道成为第一个维度；除以255把像素范围转换到0～1。
    input_tensor = rgb.transpose(2, 0, 1)
    input_tensor = input_tensor.astype(np.float32) / 255.0

    # 在最前面增加batch维，最终形状为[1, 3, H, W]。
    input_tensor = input_tensor.reshape(
        1,
        3,
        target_height,
        target_width,
    )

    # ascontiguousarray保证底层数据连续，ONNX Runtime可以直接读取这段CPU内存。
    return (
        np.ascontiguousarray(input_tensor),
        scale,
        pad_left,
        pad_top,
    )


def draw_results(
    image: np.ndarray,
    boxes: np.ndarray,
    class_ids: np.ndarray,
    scores: np.ndarray,
) -> None:
    """
    在image原图上绘制边框、类别编号和置信度。

    image由调用者持有，本函数直接修改该数组，不创建第二张结果图。
    """
    # 三个数组保持相同长度，zip每次取出同一个检测目标的框、类别和分数。
    for box, class_id, score in zip(boxes, class_ids, scores):
        x1, y1, x2, y2 = [int(round(value)) for value in box]

        # boxes已经还原到原图坐标，可以直接交给OpenCV绘制。
        cv2.rectangle(
            image,
            (x1, y1),
            (x2, y2),
            (0, 255, 0),
            2,
        )
        label = f"class={class_id} score={score:.3f}"
        cv2.putText(
            image,
            label,
            (x1, max(20, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            1,
            cv2.LINE_AA,
        )
        print(label, f"box=({x1}, {y1}, {x2}, {y2})")


def main() -> None:
    """
    完成一次瑞芯微优化YOLO11 ONNX推理。

    执行顺序：
        检查文件 → 创建InferenceSession → 准备输入 → session.run()
        → 九输出后处理 → 坐标还原 → 保存图片。
    """
    # 文件不存在时立即停止，避免后面把路径错误误判成模型加载问题。
    if not MODEL_PATH.is_file():
        raise FileNotFoundError(f"找不到模型：{MODEL_PATH.resolve()}")
    if not IMAGE_PATH.is_file():
        raise FileNotFoundError(f"找不到图片：{IMAGE_PATH.resolve()}")

    # 1. ONNX Runtime读取并准备模型。此时还没有输入数据，也没有执行推理。
    # session对象从这里开始持有已经加载的模型，直到main()结束后才释放。
    session = ort.InferenceSession(
        path_or_bytes=str(MODEL_PATH),
        sess_options=None,
        providers=["CPUExecutionProvider"],
        provider_options=None,
    )

    # 元数据用于建立输入字典并确认当前文件确实是瑞芯微九输出模型。
    input_infos = session.get_inputs()
    output_infos = session.get_outputs()

    # 输入输出数量不符合预期时直接拒绝该文件，后处理不会收到错误结构的数据。
    if len(input_infos) != 1:
        raise RuntimeError(
            f"本Demo要求单输入模型，实际输入数量为{len(input_infos)}"
        )
    if len(output_infos) != 9:
        raise RuntimeError(
            f"本Demo要求瑞芯微九输出YOLO11，实际输出数量为{len(output_infos)}"
        )

    # 保存唯一输入的名称、形状和类型；session.run()稍后要使用这个名称。
    input_info = input_infos[0]
    print("模型输入：", input_info.name, input_info.shape, input_info.type)
    for index, output_info in enumerate(output_infos):
        print(
            f"模型输出{index}：",
            output_info.name,
            output_info.shape,
            output_info.type,
        )

    # 固定输入模型直接从元数据读取高宽；动态输入模型在本Demo中使用640×640。
    # 这里只读取NCHW中的第2、3轴，所以要求输入接口共有4个维度。
    if (
        len(input_info.shape) == 4
        and isinstance(input_info.shape[2], int)
        and isinstance(input_info.shape[3], int)
    ):
        input_height = input_info.shape[2]
        input_width = input_info.shape[3]
    else:
        input_height, input_width = DEFAULT_INPUT_SIZE

    # 2. 读取原图。imread成功时返回HWC排列的BGR uint8数组。
    image = cv2.imread(str(IMAGE_PATH))
    if image is None:
        raise RuntimeError(f"OpenCV无法解码图片：{IMAGE_PATH.resolve()}")

    # letterbox既产生模型输入，也返回后面坐标还原所需的缩放和填充信息。
    original_height, original_width = image.shape[:2]
    input_tensor, scale, pad_left, pad_top = letterbox(
        image,
        input_height,
        input_width,
    )

    # 3. 这一句真正执行ONNX模型。
    # input_feed把模型输入名称与本次NumPy数组对应起来。
    # output_names=None要求返回九个图输出。
    # 调用返回后，raw_outputs依次保存80×80、40×40、20×20三个分支的结果。
    raw_outputs = session.run(
        output_names=None,
        input_feed={input_info.name: input_tensor},
        run_options=None,
    )

    # 打印实际结果可以确认输出顺序和形状；这些数组仍是后处理前的原始输出。
    print("ONNX Runtime返回输出数量：", len(raw_outputs))
    for index, output in enumerate(raw_outputs):
        print(
            f"实际输出{index}：shape={output.shape}, dtype={output.dtype}"
        )

    # 4. 模型执行已经结束。下面开始运行模型外部的YOLO11后处理。
    # post_process先解码三个尺度，再做置信度筛选和逐类别NMS。
    boxes, class_ids, scores = post_process(
        outputs=raw_outputs,
        input_size=(input_height, input_width),
        confidence_threshold=0.25,
        iou_threshold=0.45,
    )

    # post_process返回640×640输入图坐标；绘图前还原到原图坐标。
    boxes = scale_boxes_to_original(
        boxes=boxes,
        scale=scale,
        pad_left=pad_left,
        pad_top=pad_top,
        original_width=original_width,
        original_height=original_height,
    )

    # draw_results直接修改image数组，随后imwrite把修改后的数组保存到磁盘。
    draw_results(image, boxes, class_ids, scores)

    if not cv2.imwrite(str(RESULT_PATH), image):
        raise RuntimeError(f"结果图片保存失败：{RESULT_PATH.resolve()}")

    print("实际执行后端：", session.get_providers())
    print("最终检测数量：", len(boxes))
    print("结果图片：", RESULT_PATH.resolve())


if __name__ == "__main__":
    main()
```

运行：

```bash
cd yolo11_onnx_demo
python infer_yolo11_onnx.py
```

程序中真正使用ONNX模型的代码集中在三处：

1. `ort.InferenceSession(...)`加载`yolo11n.onnx`。
2. `session.get_inputs()`和`session.get_outputs()`取得模型调用接口。
3. `session.run(...)`把`input_tensor`送入模型并返回九个原始输出。

`post_process(...)`及其内部函数全部属于模型外部后处理。替换成其他ONNX模型时，前三处调用方法仍然成立，输入数据构造和输出解释需要按照新模型的接口更换。
