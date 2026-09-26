---
title: '[嵌入式AI-推理部署] ONNX转RKNN及板端推理的常见问题与解决方法'
published: 2026-09-24T08:35:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍ONNX转RKNN及板端推理的常见问题与解决方法的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-8 ONNX转RKNN及板端推理的常见问题与解决方法

RKNN部署排障的基本规则是先确定故障第一次出现在哪个阶段，再检查该阶段的输入、配置、输出和日志。模型转换、量化、板端Runtime和YOLO后处理属于不同环节，同时修改多个环节会使故障来源更难确认。

本文沿用阶段4-3的ONNX Runtime数值基线、阶段4-6的量化误差分析和阶段4-7的RKNN转换与C++推理流程。本节重点说明出现问题后怎样缩小范围、保留证据并验证修改结果。

## 1 根据故障第一次出现的位置划分RKNN问题

### 1.1 转换失败、运行失败、结果错误与性能问题的边界

同一句“RKNN模型有问题”可能对应完全不同的故障。第一步要找到最后一个成功步骤和第一个失败步骤：

| 第一个失败位置 | 直接现象 | 当前优先检查的对象 |
| --- | --- | --- |
| ONNX Checker或ONNX Runtime | 模型无法检查或无法完成ONNX推理 | ONNX结构、opset、输入名称、shape与dtype |
| `load_onnx()` | Toolkit2无法解析模型 | Toolkit2版本、ONNX opset、算子定义与动态shape |
| `build()` | 解析成功，图优化、量化或NPU编译失败 | 目标芯片、具体节点属性、常量输入、校准数据与量化配置 |
| `export_rknn()` | 前一步成功，但文件无法写出 | 输出目录、权限、磁盘空间和前序返回值 |
| `rknn_init()` | 板端无法建立模型上下文 | RKNN目标芯片、Runtime、驱动、模型文件完整性 |
| `rknn_inputs_set()`或`rknn_run()` | 上下文已建立，输入或执行失败 | 输入数量、字节数、layout、dtype和缓冲区有效期 |
| 推理成功但结果错误 | API返回成功，置信度、类别或框异常 | 预处理、量化、原始输出解释和CPU后处理 |
| 结果正确但速度慢 | 功能正确，端到端耗时过高 | 预处理、内存复制、NPU执行、后处理和绘制耗时 |

例如，`build()`已经失败后，继续调用`export_rknn()`还会得到“RKNN模型不存在”一类错误。真正需要处理的是前面的`build()`错误，后一个错误只说明导出所需的编译结果没有生成。

因此，转换脚本中的每个返回值都应立即检查。某一步失败后直接结束当前流程，防止后续错误覆盖真正原因。

### 1.2 排障前需要保存的版本、配置、日志与输入输出信息

排障需要能够复现同一次转换。至少保存下面这些信息：

- Toolkit2的完整版本号和安装它的Python版本；
- 使用的`requirements`文件与Toolkit2 wheel文件名；
- `target_platform`、量化开关、`mean_values`、`std_values`和校准TXT；
- 原始ONNX文件、opset、输入输出名称、shape和dtype；
- 转换脚本及其完整终端日志；
- RKNN模型文件、板端`librknnrt.so`、RKNPU驱动版本；
- 固定测试图片以及预处理后真正交给模型的输入张量。

Linux下可以同时在终端显示日志并保存文件：

```bash
# 2>&1把标准错误合并到标准输出，因为Toolkit2的错误信息可能写入标准错误。
# tee在终端继续显示内容，同时把完整内容保存到convert.log。
python convert.py 2>&1 | tee convert.log
```

日志要从第一次出现`E`、`ERROR`、`failed`或`unsupported`附近开始阅读。只保留最后十行经常会丢失节点名称、shape和属性等关键上下文。

## 2 构建RKNN模型时可能出现的问题

PC端构建路径只有四步：

```text
ONNX文件
→ load_onnx()读取
→ build()优化、量化并面向目标NPU编译
→ export_rknn()写出模型
```

排查时只处理第一个失败步骤。`load_onnx()`失败先检查ONNX；`build()`失败再检查算子、shape、dtype和量化；前两步成功后，`export_rknn()`失败通常只涉及输出目录、权限或磁盘空间。

### 2.1 ONNX Opset超出当前RKNN Toolkit2支持范围

Opset是ONNX为标准算子域声明的一组算子定义版本。模型在`opset_import`中记录版本，同一标准域中的节点按照这个版本解释。

你当前使用RKNN Toolkit2 2.3.2。官方2.3.2算子支持表按照ONNX Opset 19列出支持情况，官方更新记录说明Toolkit2从1.6.0开始支持ONNX Opset 12～19。[RKNN Toolkit2 2.3.2算子支持表](https://github.com/airockchip/rknn-toolkit2/blob/master/doc/RKNNToolKit2_OP_Support-2.3.2.md)、[RKNN Toolkit2更新记录](https://github.com/airockchip/rknn-toolkit2/blob/master/CHANGELOG.md)

因此，当前YOLO11部署流程在PT转ONNX时优先明确指定Opset 19：

```python
model.export(
    format="onnx",
    opset=19,
    imgsz=640,
    batch=1,
    dynamic=False,
)
```

如果换成旧版Toolkit2，需要查看该版本附带的算子支持文档，不能继续套用2.3.2的结论。

已经生成ONNX后，可以读取它声明的版本：

```python
import onnx

model = onnx.load("best.onnx")

for opset in model.opset_import:
    # 空域表示ONNX标准域ai.onnx；其他字符串表示自定义或扩展算子域。
    domain = opset.domain if opset.domain else "ai.onnx"
    print(f"domain={domain}, opset={opset.version}")
```

输出`domain=ai.onnx, opset=19`表示标准ONNX节点按照Opset 19解释。版本位于12～19范围内只说明整体Opset满足当前Toolkit2范围，具体节点仍要继续看下一节。

### 2.2 算子类型、属性、shape或dtype不满足RKNN限制

`load_onnx()`能够读取模型，`build()`仍可能在某个节点失败。RKNN对一个算子的支持由下面几项共同决定：

- 算子类型，例如`Conv`、`Resize`或`GridSample`；
- 算子属性，例如`Resize`使用的插值模式；
- 输入和输出shape，包括维度数量、各轴大小和batch；
- 张量dtype，例如`float32`、`int64`或`bool`；
- 某些参数是否为常量；
- Toolkit2版本和`target_platform`指定的目标芯片。

例如，2.3.2支持表列出了`Resize`，同时把支持模式限制为二维nearest和bilinear；`Softmax`还带有batch为1的限制。算子名称出现在支持表中，只能说明它存在受支持用法。

提前避免这类问题时按下面顺序处理：

1. YOLO11优先使用Rockchip适配的导出仓库和固定输入尺寸；
2. PT转ONNX时固定`opset=19`、`batch=1`和`dynamic=False`；
3. 使用ONNX Checker确认结构合法，再用ONNX Runtime完成一次基础推理；
4. 对照与Toolkit2版本匹配的算子支持表；
5. 先执行`build(do_quantization=False)`，确认图优化和NPU编译能够完成；
6. 失败时从转换日志的第一条`E`、`ERROR`、`unsupported`或`failed`开始读，记录节点名称、算子类型、shape、dtype和属性，再到Netron中定位同名节点。

支持表中的“不支持”也不等于每个包含该节点的模型都会立刻失败。Toolkit2优化器可能先把节点改写成其他受支持结构，或者把节点消除。第9部分Demo保留了`Abs`被自动改写以及`Acos`无法正常下沉NPU的实验，实际结论应同时看支持表和转换日志。

### 2.3 动态shape、输入接口和模型结构造成的构建失败

常见现象包括：

- ONNX输入维度仍带有字符串或`-1`，`load_onnx()`要求提供固定shape；
- 导出时允许动态batch、高度或宽度，当前模型结构或目标芯片无法按该范围编译；
- `load_onnx()`中手动填写的输入名称与模型真实名称不一致；
- ONNX输入dtype与Toolkit2读取到的输入类型不一致；
- ONNX Checker通过，但常量折叠或图优化运行到具体节点时才发现shape不合法。

YOLO11在RK3588上的第一条验证路径应使用固定`[1, 3, 640, 640]`。先让固定模型完成`load_onnx() → build()`，确实需要多个输入尺寸时再按照Toolkit2动态输入接口单独配置。这样可以把动态shape问题与算子问题分开。

转换脚本没有裁剪模型的需求时，也不要额外填写`inputs`、`input_size_list`和`outputs`。直接使用：

```python
ret = rknn.load_onnx(model="/home/user/my_yolo/best.onnx")
```

只有ONNX本身保留动态输入，或者确实需要截取子图时，才增加这些参数。

### 2.4 INT8量化构建失败或量化误差过大

量化问题分成两种。

第一种发生在`build(do_quantization=True, dataset=...)`期间，模型没有生成。常见原因是：

- `dataset.txt`路径错误；
- TXT中的某张图片路径无效或图片无法解码；
- 校准图片预处理后无法满足模型输入shape；
- 量化阶段遇到不支持量化的节点或数据类型；
- `mean_values`、`std_values`与正式输入约定不一致。

第二种是INT8模型构建成功，但浮点参考值与INT8模拟值差异明显。常见原因是：

- 校准图片与真实输入域差异过大；
- 校准数据没有覆盖亮度、背景和目标尺度；
- 少数异常样本把激活范围拉得过宽；
- 某些中间层对INT8较敏感。

排查顺序固定为：

1. 使用同一个ONNX执行`build(do_quantization=False)`；
2. 非INT8构建失败时，返回2.1～2.3节处理模型结构问题；
3. 非INT8构建成功后，再使用正式校准集构建INT8；
4. INT8构建失败时，先核对校准TXT、图片和`config()`输入配置；
5. INT8构建成功但误差过大时，调用阶段4-7第4.8节的`accuracy_analysis()`。

`accuracy_analysis()`生成`error_analysis.txt`、`golden/`和`simulator/`。先看模型最后输出张量的`entire cos`，再向前找`entire cos`第一次明显下降的位置，最后看该层`single cos`。`single cos`同时明显降低时，当前层更可能是量化敏感层；`single cos`仍接近1时，当前差异主要来自前面各层累积。

校准图片怎样选择、数量和覆盖范围已经在阶段4-6第6节说明。这里的处理重点是确认故障只在INT8路径出现，再使用逐层报告定位。

## 3 RKNN模型在板端从输入到输出可能出现的问题

板端范围限定为：

```text
读取.rknn文件
→ rknn_init()建立上下文
→ rknn_query()读取模型接口
→ rknn_inputs_set()提交输入
→ rknn_run()执行模型
→ rknn_outputs_get()取得模型输出
→ rknn_outputs_release()释放输出
→ rknn_destroy()销毁上下文
```

本部分只检查模型入口、模型执行和模型出口。

### 3.1 rknn_init无法加载模型

`rknn_init()`失败时，模型还没有进入可推理状态。常见原因包括：

- 转换时`target_platform`没有选择实际板端芯片；
- `.rknn`文件复制不完整、读取失败或传入字节数错误；
- 板端`librknnrt.so`与RKNPU驱动版本不匹配；
- 模型由更高版本Toolkit2生成，板端Runtime过旧；
- 应用链接到错误架构或错误版本的Runtime库。

先保存`rknn_init()`返回值，再核对模型文件大小和哈希。初始化成功后，可以通过`RKNN_QUERY_SDK_VERSION`读取Runtime API与驱动版本。初始化失败时查看最新内核日志：

```bash
dmesg | tail -n 80
```

排查时要同时记录三项版本：生成模型的RKNN Toolkit2、板端`librknnrt.so`以及RKNPU驱动。只升级其中一项可能继续保留兼容问题。

### 3.2 模型输入数量、shape、layout、dtype或缓冲区不正确

`rknn_init()`成功后，先使用`rknn_query()`读取真实接口。程序不应只依赖源码里写死的640、RGB或`uint8`。

需要读取：

- `RKNN_QUERY_IN_OUT_NUM`返回的输入输出数量；
- `RKNN_QUERY_INPUT_ATTR`返回的`dims`、`fmt`、`type`和`size`；
- 模型输入是否经过阶段4-7中`mean_values`与`std_values`配置。

`rknn_inputs_set()`常见错误包括：

- `index`超出输入数量；
- `size`小于模型需要的字节数；
- 内存是NCHW，`fmt`却填写NHWC；
- 缓冲区存储`float32`，`type`却填写`RKNN_TENSOR_UINT8`；
- 图片为BGR，模型入口约定为RGB；
- 转换配置已经执行除以255，应用又把输入手动除以255；
- 普通输入缓冲区在`rknn_inputs_set()`执行期间无效，或者零拷贝输入内存没有按照对应API保持到NPU执行完成。

对于阶段4-7中的YOLO11配置，应用提交RGB、NHWC、`uint8`、0～255输入，`mean_values=[[0,0,0]]`与`std_values=[[255,255,255]]`再完成逐通道除以255。如果自己的ONNX输入约定不同，应以该模型的`config()`和`rknn_query()`结果为准。

### 3.3 rknn_run执行失败或模型内部执行路径异常

`rknn_run()`返回非0时，先确认前面的`rknn_inputs_set()`已经成功，再记录Runtime返回值和`dmesg`。常见原因包括：

- 输入描述与模型接口不一致；
- Runtime、驱动和模型版本组合不兼容；
- NPU任务提交失败；
- 模型包含板端Runtime无法执行的目标层；
- 多线程程序错误地共享或销毁同一个`rknn_context`。

转换成功也要查看构建日志中的网络层表。如果某些层被标记为CPU目标，板端Runtime必须提供对应执行实现；Demo第9.1节的`Acos`案例就用于观察这种边界。

若模型能够运行但`rknn_run()`耗时异常，只统计这个API本身的时间，并查看构建日志中每层的`Target`。这样得到的是模型内部执行时间，输入准备和模型输出之后的工作不计入这里。

### 3.4 rknn_outputs_get取得的输出数量、类型或数值不正确

输出数量、顺序、shape和dtype以`RKNN_QUERY_OUTPUT_ATTR`为准。`rknn_outputs_get()`只返回RKNN模型声明的输出，不会自动改变应用对各输出张量含义的约定。

常见问题包括：

- `rknn_output.index`与模型输出顺序不一致；
- 申请的输出数量与`n_output`不一致；
- INT8输出按照`float32`指针直接读取；
- `want_float=0`时忘记使用输出属性中的`zp`和`scale`解释量化值；
- `want_float=1`返回反量化浮点值，却仍然再次执行反量化；
- 调用`rknn_outputs_release()`以后继续访问`outputs[i].buf`；
- 忘记调用`rknn_outputs_release()`，导致重复推理时资源持续累积。

调试量化输出时可以暂时设置`want_float=1`，让Runtime返回便于比较的浮点值。这个设置包含额外的数据转换，性能测试应使用正式部署配置。

输出缓冲区由Runtime提供时，它的有效期到`rknn_outputs_release()`为止。应用需要长期保存输出时，应在释放前复制所需数据。

### 3.5 使用同一输入比较PC模拟器与板端原始输出

模型能够执行但输出数值异常时，只比较模型入口和模型出口：

1. 保存板端真正提交给`rknn_inputs_set()`的完整输入字节；
2. 在PC模拟器中使用相同shape、layout、dtype和数值；
3. 两端都取得模型原始输出，并按相同输出顺序和浮点形式保存；
4. 比较每个同shape输出的最大绝对误差、平均绝对误差和余弦相似度。

如果板端输入字节已经不同，先修正入口数据。输入完全一致而PC模拟器与板端输出差异明显时，重点检查Runtime、驱动、输出dtype和量化参数解释。非INT8模拟结果正常、INT8模拟结果已经异常时，问题发生在构建量化路径，应返回2.4节处理。

逐层中间值由PC端`accuracy_analysis()`分析；板端普通`rknn_outputs_get()`只能读取模型声明的输出。需要查看某个特定中间层时，可以把该层临时添加为调试模型输出后重新转换。调试模型只用于定位，不作为最终性能模型。

## 9 RKNN转换与推理故障专项Demo

### 9.1 区分支持表中的不支持、优化器自动改写与CPU目标标记

官方支持表中的“不支持”表示当前RKNN编译链没有把该ONNX算子作为普通目标算子直接编译的支持承诺。实际转换前还有一层图优化：如果优化器能够识别等价结构，它可以先删除原节点，添加另一个受支持节点，再将改写后的计算图交给编译器。

`Abs`就是一个已经观察到的例子。Toolkit2 2.3.2转换日志会显示：

```text
convert_abs_to_leakyrelu:
remove node = ['unsupported_abs_node']
add node = ['unsupported_abs_node_2leakyrelu']
```

随后网络层表中出现的是NPU执行的`LeakyRelu`。这个改写利用：

$$
|x|=\operatorname{LeakyReLU}(x,\alpha=-1)
$$

当$x\ge 0$时输出$x$；当$x<0$时输出$-x$。因此，`Abs`适合说明“支持表不能代替实际转换日志”，不适合继续作为稳定的失败样例。

下面改用反余弦算子`Acos`。它接收$[-1,1]$范围内的输入，并输出对应角度，单位为弧度。Toolkit2 2.3.2官方表将ONNX `Acos`列为不支持；这个实验让`Acos`直接接收运行时输入，常量折叠无法提前计算它，也没有`Abs→LeakyRelu`这类简单自动改写路径。[RKNN Toolkit2 2.3.2算子支持表](https://github.com/airockchip/rknn-toolkit2/blob/master/doc/RKNNToolKit2_OP_Support-2.3.2.md)

实际日志显示，Toolkit2仍然能够导出包含`Acos`的RKNN文件，但把整个最小模型标记为纯CPU模型。这个结果说明“生成了`.rknn`文件”和“算子进入NPU执行”需要分别判断：前者看`building done`与导出结果，后者看网络层表中的`Target`列以及是否存在lowering。lowering表示编译器把上层算子转换成目标执行实现的过程。日志同时提示`No lowering found`，所以导出成功也不能证明板端Runtime已经具备直接执行该CPU算子的实现。

依赖为Python、NumPy、ONNX和ONNX Runtime：

```bash
# -i使用清华PyPI镜像加速普通Python依赖下载。
pip install numpy onnx onnxruntime \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --no-cache-dir
```

创建`make_acos_models.py`。脚本会生成两个文件：

- `acos_unsupported.onnx`保留`Acos`，用于观察无法下沉NPU后的CPU目标标记；
- `acos_rknn_part.onnx`只用受支持的`Clip`把输入限制在反余弦定义域内，输出交给CPU继续执行`acos()`。

```python
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper


ACOS_MODEL_PATH = Path("acos_unsupported.onnx")
RKNN_PART_MODEL_PATH = Path("acos_rknn_part.onnx")


def save_and_check(model: onnx.ModelProto, output_path: Path) -> None:
    """检查并保存一个ONNX模型。

    参数model由当前脚本创建，函数不接管其他外部资源。
    checker失败时直接抛出异常，损坏的模型不会进入后续RKNN测试。
    """
    onnx.checker.check_model(model)
    onnx.save(model, output_path)
    print(f"已生成并检查：{output_path}")


def build_acos_model() -> onnx.ModelProto:
    """创建y=Acos(x)模型，用于观察当前版本如何处理无NPU实现的算子。

    输入和输出shape均为[1, 5]。输入必须落在[-1, 1]内，
    这是实数反余弦函数的定义域，也是本实验的数据约束。
    """
    input_info = helper.make_tensor_value_info(
        "input", TensorProto.FLOAT, [1, 5]
    )
    output_info = helper.make_tensor_value_info(
        "output", TensorProto.FLOAT, [1, 5]
    )

    # Acos直接读取运行时输入，转换器无法通过常量折叠提前删除这个节点。
    # 显式节点名用于在Toolkit2日志和Netron中定位同一个操作。
    acos_node = helper.make_node(
        "Acos",
        inputs=["input"],
        outputs=["output"],
        name="unsupported_acos_node",
    )

    graph = helper.make_graph(
        [acos_node],
        "acos_unsupported_graph",
        [input_info],
        [output_info],
    )
    return helper.make_model(
        graph,
        opset_imports=[helper.make_operatorsetid("", 19)],
        producer_name="rknn_troubleshooting_demo",
        # 某些旧版ONNX Runtime最高支持IR 9。显式设置IR版本用于兼容
        # 这类环境；它与PyTorch是否使用CUDA没有关系。
        ir_version=9,
    )


def build_rknn_part_model() -> onnx.ModelProto:
    """创建留给RKNN执行的Clip部分，并输出CPU后处理所需张量。

    Clip的输入、输出shape都是[1, 5]。模型不再包含Acos，
    应用取得clipped_input后调用CPU的acos函数完成原始任务。
    """
    input_info = helper.make_tensor_value_info(
        "input", TensorProto.FLOAT, [1, 5]
    )
    output_info = helper.make_tensor_value_info(
        "clipped_input", TensorProto.FLOAT, [1, 5]
    )

    # opset 19的Clip把最小值和最大值作为输入张量。
    # min和max必须是零维标量，shape写成[]；写成[1]会成为一维向量，
    # Toolkit2内部ONNX Runtime执行常量折叠时会报告“min should be a scalar”。
    minimum = helper.make_tensor(
        name="clip_min",
        data_type=TensorProto.FLOAT,
        dims=[],
        vals=[-1.0],
    )
    maximum = helper.make_tensor(
        name="clip_max",
        data_type=TensorProto.FLOAT,
        dims=[],
        vals=[1.0],
    )
    clip_node = helper.make_node(
        "Clip",
        inputs=["input", "clip_min", "clip_max"],
        outputs=["clipped_input"],
        name="rknn_supported_clip",
    )

    graph = helper.make_graph(
        [clip_node],
        "acos_rknn_part_graph",
        [input_info],
        [output_info],
        initializer=[minimum, maximum],
    )
    return helper.make_model(
        graph,
        opset_imports=[helper.make_operatorsetid("", 19)],
        producer_name="rknn_troubleshooting_demo",
        ir_version=9,
    )


def run_onnx(model_path: Path, input_data: np.ndarray) -> np.ndarray:
    """使用CPU执行ONNX，并返回唯一输出张量。"""
    session = ort.InferenceSession(
        str(model_path), providers=["CPUExecutionProvider"]
    )
    input_name = session.get_inputs()[0].name
    return session.run(None, {input_name: input_data})[0]


acos_model = build_acos_model()
rknn_part_model = build_rknn_part_model()
save_and_check(acos_model, ACOS_MODEL_PATH)
save_and_check(rknn_part_model, RKNN_PART_MODEL_PATH)

# 这五个输入覆盖反余弦定义域的两个端点、零和中间值。
test_input = np.array([[-1.0, -0.5, 0.0, 0.5, 1.0]], dtype=np.float32)
original_output = run_onnx(ACOS_MODEL_PATH, test_input)
rknn_part_output = run_onnx(RKNN_PART_MODEL_PATH, test_input)

# RKNN部分只输出定义域内的数据；CPU接管后调用np.arccos完成剩余计算。
# 这里先用ONNX Runtime模拟RKNN部分，验证“RKNN输出→CPU后处理”的完整结果。
cpu_finished_output = np.arccos(rknn_part_output)
np.testing.assert_allclose(
    cpu_finished_output,
    original_output,
    rtol=1e-6,
    atol=1e-6,
)

print("输入：", test_input)
print("原始Acos模型输出：", original_output)
print("RKNN部分输出：", rknn_part_output)
print("CPU完成Acos后的输出：", cpu_finished_output)
print("拆分后的完整结果与原始ONNX一致")
```

执行：

```bash
python make_acos_models.py
```

原始`Acos`模型会输出约`[3.141593, 2.094395, 1.570796, 1.047198, 0]`。RKNN部分输出仍为输入值，CPU执行`np.arccos()`后得到与原始模型一致的结果。

### 9.2 比较Acos纯CPU目标与Clip下沉NPU的转换日志

接着创建一个只负责转换单个FP ONNX的`convert_one.py`。脚本参数依次是输入ONNX和输出RKNN，不包含量化，可以把算子问题与校准问题分开：

```python
import sys
from pathlib import Path

from rknn.api import RKNN


if len(sys.argv) != 3:
    raise SystemExit(
        f"用法：{sys.argv[0]} <input.onnx> <output.rknn>"
    )

onnx_path = Path(sys.argv[1])
rknn_path = Path(sys.argv[2])
if not onnx_path.is_file():
    # 输入不存在时立即结束，防止路径问题混入算子兼容性实验。
    raise FileNotFoundError(f"找不到ONNX模型：{onnx_path.resolve()}")

rknn = RKNN(verbose=True)
try:
    ret = rknn.config(target_platform="rk3588")
    if ret != 0:
        raise RuntimeError(f"config失败，返回值={ret}")

    ret = rknn.load_onnx(model=str(onnx_path))
    if ret != 0:
        # load失败后没有可供build使用的有效模型，当前实验在这里结束。
        raise RuntimeError(f"load_onnx失败，返回值={ret}")

    ret = rknn.build(do_quantization=False)
    if ret != 0:
        # 关闭量化后仍然失败，当前错误应优先从图优化和算子编译方向检查。
        raise RuntimeError(f"build失败，返回值={ret}")

    ret = rknn.export_rknn(str(rknn_path))
    if ret != 0:
        raise RuntimeError(f"export_rknn失败，返回值={ret}")

    print(f"RKNN模型已经生成：{rknn_path}")
finally:
    # 无论正常完成还是中途抛出异常，都释放Toolkit2对象持有的资源。
    rknn.release()
```

分别转换两个模型并保存独立日志：

```bash
python make_acos_models.py

python convert_one.py acos_unsupported.onnx acos_unsupported.rknn \
  2>&1 | tee acos_unsupported.log

python convert_one.py acos_rknn_part.onnx acos_rknn_part.rknn \
  2>&1 | tee acos_rknn_part.log
```

两次转换都生成了RKNN文件，但执行位置不同。下面粘贴两份实际日志中用于判断的原文；大量只有`start`和`end`的重复优化Pass没有继续展开，因为它们只表示该Pass执行完毕，没有增加算子执行位置的信息。

第一份是保留`Acos`的模型：

```text
I rknn-toolkit2 version: 2.3.2
W load_onnx: The config.mean_values is None, zeros will be set for input 0!
W load_onnx: The config.std_values is None, ones will be set for input 0!
I rknn building ...
I rknn building done.
RKNN模型已经生成：acos_unsupported.rknn

D RKNN: detect pure cpu op model.
D RKNN: Network Layer Information Table
D RKNN: ID   OpType         DataType Target InputShape OutputShape FullName
D RKNN: 0    InputOperator  FLOAT16  CPU    \          (1,5)      InputOperator:input
D RKNN: 1    Acos           FLOAT16  CPU    (1,5)      (1,5)      Acos:unsupported_acos_node
D RKNN: 2    OutputOperator FLOAT16  CPU    (1,5)      \          OutputOperator:output

No lowering found for: unsupported_acos_node,
node type = Acos, use CustomOperatorLower instead.
```

这份日志按下面顺序阅读：

1. `rknn-toolkit2 version: 2.3.2`确认本次结论对应的工具版本；
2. `mean_values is None`和`std_values is None`表示输入使用均值0、标准差1，本实验没有图像归一化需求，所以这两条警告不会阻止转换；
3. `rknn building done`和“RKNN模型已经生成”确认转换与导出成功；
4. `detect pure cpu op model`说明整个最小模型被识别为纯CPU目标模型；
5. 网络层表中`Acos`对应的`Target`是`CPU`，这条才是“Acos没有进入NPU”的直接证据；
6. `No lowering found`说明编译器没有找到`Acos`的目标lowering，并提示如需扩展可考虑自定义算子路径。这条信息还意味着需要继续做板端加载和推理测试，不能用导出成功代替可运行验证。

终端使用`2>&1 | tee`合并标准输出与标准错误后，两类流仍分别刷新各自的缓冲，所以`building done`可能显示在调试表格中间。判断成功与否要同时看返回流程、`building done`和输出文件，不能只根据显示顺序判断。

第二份是移除`Acos`、只保留`Clip`的模型：

```text
I rknn-toolkit2 version: 2.3.2
W load_onnx: The config.mean_values is None, zeros will be set for input 0!
W load_onnx: The config.std_values is None, ones will be set for input 0!
D fuse_ops results:
D     unsqueeze_to_4d_clip: remove node = [],
D     add node = ['input_rs', 'clipped_input-rs']

W RKNN: Tensor clip_min need parameter qtype, type is set to float16 by default!
W RKNN: Tensor clip_max need parameter qtype, type is set to float16 by default!
E RKNN: Unkown op target: 0

D RKNN: Network Layer Information Table
D RKNN: ID   OpType         DataType Target InputShape        OutputShape FullName
D RKNN: 0    InputOperator  FLOAT16  CPU    \                 (1,5)       InputOperator:input
D RKNN: 1    Reshape        FLOAT16  CPU    (1,5),(4)         (1,1,1,5)   Reshape:input_rs
D RKNN: 2    Clip           FLOAT16  NPU    (1,1,1,5),(1),(1) (1,1,1,5)   Clip:rknn_supported_clip
D RKNN: 3    Reshape        FLOAT16  CPU    (1,1,1,5),(2)     (1,5)       Reshape:clipped_input-rs
D RKNN: 4    OutputOperator FLOAT16  CPU    (1,5)             \           OutputOperator:clipped_input

D RKNN: Const Tensor Information Table
D RKNN: User Tensor    DataType OrigShape
D RKNN: Clip clip_min  FLOAT    (1)
D RKNN: Clip clip_max  FLOAT    (1)

I rknn building done.
RKNN模型已经生成：acos_rknn_part.rknn
```

这份日志说明：

1. `unsqueeze_to_4d_clip`表示优化器为`Clip`前后添加了`Reshape`，把原来的二维输入临时整理为NPU使用的四维形式；
2. `clip_min`和`clip_max`没有显式量化类型，编译器选择FP16，因此出现`qtype`警告；本次是FP模型，该警告没有中止构建；
3. 网络层表中的`Clip ... Target NPU`确认核心`Clip`节点已经下沉到NPU；两个`Reshape`和输入输出包装节点显示为CPU，它们承担形状整理与模型边界工作；
4. 源ONNX中`clip_min`和`clip_max`必须使用`dims=[]`创建零维标量。导入和内部图变换完成后，常量表把它们显示成`OrigShape (1)`，这是编译器内部的一元素存储形式，不表示源ONNX又变回了一维向量；
5. 日志虽然出现`Unkown op target: 0`，后面仍然完成网络层生成、模型导出并打印`building done`。在这次最小模型中它没有形成致命错误；
6. “RKNN模型已经生成：`acos_rknn_part.rknn`”确认拆分后的RKNN部分能够正常导出。

两份日志合起来给出的结论是：

```text
保留Acos
→ 能生成RKNN文件
→ Acos在层表中标为CPU目标
→ 板端能否执行仍需验证
→ 没有得到该算子的NPU加速

移除Acos并保留Clip
→ Clip进入NPU
→ RKNN输出定义域内的中间值
→ 应用CPU继续计算acos()
```

板端应用取得`acos_rknn_part.rknn`的浮点输出后，CPU继续处理：

```cpp
#include <algorithm>
#include <cstddef>
#include <cmath>
#include <vector>

std::vector<float> finish_acos_on_cpu(const float* rknn_output,
                                      std::size_t element_count) {
    // 输入指向RKNN输出缓冲区，函数只在调用期间读取它，不接管其所有权。
    // 返回vector拥有最终结果；RKNN输出释放后，返回值仍然有效。
    std::vector<float> final_output;
    final_output.reserve(element_count);

    for (std::size_t index = 0; index < element_count; ++index) {
        // 浮点计算可能在边界产生极小越界，例如1.0000001。
        // clamp把输入限制在acos的实数定义域[-1, 1]内。
        const float valid_value = std::clamp(
            rknn_output[index], -1.0F, 1.0F
        );
        final_output.push_back(std::acos(valid_value));
    }
    return final_output;
}
```

CPU处理必须放在`rknn_outputs_get()`成功之后、`rknn_outputs_release()`之前，或者先把RKNN输出复制到应用自己的容器再释放。这个实验保留四种证据：

- `Acos`原始模型通过ONNX Checker和ONNX Runtime，说明它是合法可执行的ONNX；
- Toolkit2日志定位到`unsupported_acos_node`，说明问题位于RKNN支持边界；
- 只含`Clip`的RKNN部分能够转换；
- “RKNN部分输出→CPU `acos()`”与原始ONNX输出在给定容差内一致。

实际项目中还要扩大测试输入范围，并对最终任务指标进行回归。最小模型证明当前拆分方式可用，完整模型仍可能在其他节点继续遇到限制。此时重复“第一条有效错误→Netron节点→最小模型→单一修改→数值比较”的流程。

### 9.3 注入输入预处理错误并定位异常首次出现的位置

第二个实验沿用阶段4-7已经跑通的YOLO11n模型和固定图片。正常路径会把OpenCV读取的BGR图像转换为RGB。故障注入只取消这一步，继续保持`uint8`、NHWC和相同尺寸：

```cpp
// 正常版本：模型配置要求RGB，因此需要从OpenCV默认的BGR转换。
cv::cvtColor(letterboxed_bgr, model_input, cv::COLOR_BGR2RGB);

// 故障版本：临时保留BGR字节顺序，用于复现颜色通道错误。
// 两个缓冲区的shape、dtype和字节数相同，差异只来自通道顺序。
cv::Mat wrong_model_input = letterboxed_bgr.clone();
```

分别保存正常RGB输入和故障BGR输入，再执行相同RKNN模型和相同CPU后处理。预期观察为：

```text
原始图片相同
→ letterbox尺寸和填充相同
→ 模型输入张量第一次出现差异
→ RKNN原始输出随之变化
→ 最终置信度、类别或检测框发生变化
```

这个实验已经在输入边界找到第一处差异，因此无需先怀疑量化或NMS。如果输入张量逐元素一致，才继续比较ONNX、RKNN PC端、板端原始输出与CPU后处理。完成实验后恢复RGB转换，避免把故障注入代码留在正式推理路径中。

