---
title: '[嵌入式AI-推理部署] RKNN工具链与ONNX转RKNN基本流程'
published: 2026-09-24T08:34:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍RKNN工具链与ONNX转RKNN基本流程的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-7 RKNN工具链与ONNX转RKNN基本流程

本阶段解释一个完整问题：通用ONNX模型为什么还要经过RKNN Toolkit2转换，转换期间模型经历哪些处理，以及怎样把生成的RKNN模型交给Rockchip板端NPU运行。

主流程如下：

```text
简单检查ONNX模型
→ RKNN Toolkit2读取模型
→ 图优化与算子处理
→ 可选的量化校准
→ 面向目标NPU编译
→ 导出RKNN模型
→ 可选的量化前后逐层误差分析
→ 简单检查生成结果
→ 板端加载并推理
```

## 1 ONNX模型需要转换为RKNN才能在Rockchip NPU运行的原因

### 1.1 ONNX保存通用计算图与模型参数

开放神经网络交换格式（Open Neural Network Exchange，ONNX）是一种模型交换格式。ONNX文件主要保存：

- 由Conv、Add、Resize等算子组成的计算图；
- 卷积权重、偏置等固定参数；
- 算子属性和算子集版本；
- 模型输入、输出的名称、形状和元素类型。

这些内容描述了模型需要完成的数学计算。ONNX没有规定某一款Rockchip NPU应该怎样安排这些计算，也没有携带该NPU可以直接执行的目标代码。

ONNX Runtime能够在CPU上运行ONNX，是因为ONNX Runtime会读取计算图，再调用CPU执行提供器支持的算子内核。RKNPU驱动承担不同职责，它接收RKNN Runtime提交的NPU任务，不直接充当ONNX解释器。

### 1.2 Rockchip NPU需要面向目标芯片生成的编译结果

神经网络处理器（Neural Processing Unit，NPU）具有自己的算子支持范围、数据类型、内部数据布局和执行限制。通用ONNX图需要先经过面向目标NPU的编译处理，才能形成该平台可以加载的模型。

RKNN Toolkit2在开发电脑上完成这项工作。转换时指定`target_platform="rk3588"`，表示编译器要按照RK3588系列NPU的能力处理模型；改成其他平台后，支持的算子、量化格式和生成结果都可能变化。

转换得到的`.rknn`文件属于部署模型。它包含经过处理的计算图、权重、量化信息和目标平台所需的模型描述。该文件还需要与目标芯片、RKNN Runtime和RKNPU驱动配合使用。

### 1.3 RKNN模型、Runtime、RKNPU驱动与NPU之间的执行关系

Rockchip官方把软件栈划分为模型转换、板端接口和驱动几个部分：[RKNN Toolkit2官方说明](https://github.com/airockchip/rknn-toolkit2)。正常执行关系为：

```text
开发电脑
ONNX模型
→ RKNN Toolkit2转换
→ 生成目标平台对应的.rknn文件

Rockchip板端
.rknn文件
→ RKNN Runtime或RKNN Toolkit Lite2加载
→ RKNPU驱动接收任务
→ NPU执行计算
→ Runtime返回输出张量
```

RKNN Runtime提供C/C++接口，RKNN Toolkit Lite2提供Python接口。二者最终都要经过板端RKNPU驱动与NPU硬件交互。

## 2 ONNX转换为RKNN时经历的中间处理流程

### 2.1 转换开始前对ONNX结构和基础推理的简单检查

转换前只需要确认输入模型具备明确的调用接口，并能完成一次基础推理。具体检查方法已经在阶段4-2第2节和阶段4-3第1节讲过，这里保留转换所需的最小信息：

- ONNX Checker能够通过结构检查；
- ONNX Runtime能够加载模型并完成一次推理；
- 已经记录输入输出名称、shape和dtype；
- 已经确认输入使用NCHW还是NHWC；
- 已经确认像素范围、颜色顺序和归一化方式；
- 已经确认输出数量、顺序和每个维度的含义。

本阶段使用Rockchip Model Zoo配套的YOLO11n优化ONNX。这个模型具有九个输出，其输出结构和Ultralytics原始单输出模型不同。九个输出及其后处理已在阶段4-3第5节解释，官方模型差异可参考[Rockchip YOLO11模型说明](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/README.md#3-pretrained-model)。

### 2.2 ONNX计算图、权重与输入输出信息的读取

`load_onnx()`读取ONNX文件，将图节点、权重、算子属性和输入输出接口交给RKNN Toolkit2。此时Toolkit2开始用自己的模型表示处理这张图。

这一步能够暴露一些早期问题，例如文件无法解析、输入名称不匹配或模型结构超出当前工具支持范围。`load_onnx()`成功只说明模型已经进入转换工具，NPU编译要等到`build()`阶段完成。

### 2.3 图优化、算子融合与数据布局调整

`build()`会对计算图执行优化。可以从工程角度把这一步理解为：在保持模型计算含义的前提下，把通用ONNX图改写成更适合目标NPU处理的形式。

常见处理包括：

- 预先计算只依赖常量的节点；
- 删除不再参与最终输出的冗余节点；
- 把能够一起执行的相邻算子融合；
- 调整部分算子表达和张量数据布局；
- 为后续NPU算子映射准备图结构。

例如，卷积后紧跟批量归一化时，编译器可能把批量归一化的参数合并进卷积权重，从而减少一次独立运算。具体融合规则由Toolkit2版本、模型结构和目标平台决定，转换日志是当前模型实际处理结果的依据。

### 2.4 INT8模型的校准数据运行与量化参数生成

当`build(do_quantization=True, dataset=...)`开启训练后量化时，Toolkit2还要读取校准数据，运行模型并估计中间激活范围。这个过程对应阶段4-6第6节介绍的训练后静态量化校准。

权重来自模型文件，可以直接统计；激活值随输入变化，需要通过校准样本运行得到。Toolkit2根据这些统计结果生成各量化张量使用的`scale`、`zero-point`等参数，再把支持的计算转换到低位宽路径。

`dataset.txt`中的图片需要接近真实部署输入。校准数据的覆盖范围和数量已经在阶段4-6第6.3至6.5节说明，本阶段只负责把数据清单交给`build()`。

如果`do_quantization=False`，工具仍会执行图优化和目标平台编译，只跳过这条训练后量化校准路径。最终模型采用什么浮点格式以及哪些算子由NPU执行，仍以目标平台和Toolkit2输出为准。

### 2.5 算子映射与面向目标NPU的模型编译

图优化结束后，Toolkit2要把处理后的算子映射到目标NPU支持的实现。`target_platform`在这里直接参与决策：同一个ONNX算子能否运行、使用哪种数据类型以及怎样组合执行，都受目标芯片能力限制。

可以把这一阶段理解成“把通用模型描述编译成目标NPU模型”。如果必要算子无法被当前工具和目标平台接受，`build()`会失败或给出相关日志。算子替换、模型修改和版本兼容问题集中放在阶段4-8处理。

### 2.6 权重、计算图、量化参数与模型属性的RKNN封装

`build()`在内存中形成已经编译的RKNN模型，`export_rknn()`再把结果写入`.rknn`文件。文件中包含部署需要的模型数据，但不会自动包含YOLO检测框绘制、NMS和业务逻辑。

因此，转换边界可以写成：

```text
模型内部：卷积、特征提取、检测头等神经网络计算
→ 封装进RKNN模型

模型外部：图片读取、letterbox、结果解码、NMS、坐标还原、绘图
→ 由板端应用程序负责
```

某些预处理可以通过`rknn.config()`写入模型配置，例如本例的`mean_values`和`std_values`。板端程序必须知道哪些步骤已经进入模型，避免把同一归一化执行两次。

### 2.7 转换完成后对RKNN文件和输入输出属性的简单检查

转换结束后只做三项确认：

1. `build()`和`export_rknn()`返回成功；
2. 输出路径存在一个非空的`.rknn`文件；
3. 对应的板端Runtime能够加载模型，并且输入输出数量与应用程序预期一致。

这三项用于确认流程已经跑通，不能替代精度验证。本文第4.8节先讲怎样生成和阅读量化前后的逐层误差文件；根据异常层继续修改模型、调整量化方案和排查板端结果属于阶段4-8。

## 3 ONNX转RKNN及板端运行所使用的工具

### 3.1 ONNX Checker与ONNX Runtime用于转换前验证

ONNX Checker检查模型结构、算子定义和图连接是否合法。ONNX Runtime负责执行浮点ONNX，建立转换前的可运行基线。二者都不生成RKNN模型。

本篇不会重复阶段4-2和阶段4-3的检查代码。实际项目应保留同一张测试图片和ONNX输出，后续才能判断板端结果变化发生在转换过程还是输入输出链路。

### 3.2 RKNN Toolkit2用于模型转换、量化与编译

RKNN Toolkit2安装在开发电脑上。本文使用它完成：

```text
config配置
→ load_onnx读取ONNX
→ build优化、量化和编译
→ export_rknn写出模型
```

Toolkit2的Python包和目标平台支持具有版本相关性，应使用Rockchip SDK提供的wheel、Docker环境或与官方文档匹配的安装方式。不要把旧版RKNN Toolkit和RKNN Toolkit2混用。

### 3.3 RKNN Runtime提供板端C/C++推理接口

RKNN Runtime提供板端C/C++接口。本文最后直接使用官方Linux C++ Demo，因此后续主线由`rknn_init()`、`rknn_query()`、`rknn_inputs_set()`、`rknn_run()`、`rknn_outputs_get()`、`rknn_outputs_release()`和`rknn_destroy()`组成。

RKNN Toolkit Lite2提供板端Python接口，适合快速验证；它在本文只作为工具链成员介绍，不再用于最终Demo。Rockchip对Toolkit2、Lite2和Runtime职责的划分可参考[RKNN Toolkit2官方说明](https://github.com/airockchip/rknn-toolkit2)。

### 3.4 RKNPU驱动负责Runtime与NPU硬件之间的交互

RKNPU驱动位于操作系统内核侧。Runtime通过驱动完成NPU任务提交和硬件交互。应用程序通常不会绕过Runtime直接操作驱动。

所以，板端出现`init_runtime()`失败时，需要同时检查RKNN Toolkit Lite2或Runtime版本、RKNPU驱动版本和模型目标平台。详细版本故障排查属于阶段4-8。

## 4 从下载官方仓库到生成YOLO11n RKNN模型

### 4.1 下载RKNN Toolkit2与RKNN Model Zoo仓库

本节使用两个Rockchip官方仓库：

- `rknn-toolkit2`提供模型转换工具、板端Runtime组件、文档和示例；
- `rknn_model_zoo`提供具体模型的ONNX、转换脚本、C/C++推理源码和统一构建脚本。

先在Linux开发电脑下载仓库：

```bash
git clone https://github.com/airockchip/rknn-toolkit2.git
git clone https://github.com/airockchip/rknn_model_zoo.git
```

两个仓库应选择相互匹配的发布版本。`main`分支会继续更新；学习时可以先用`git tag`查看标签，再按SDK或开发板镜像说明切到对应版本。本文引用的是当前官方仓库结构，版本变化时以仓库中的README和`doc/`文档为准。

### 4.2 下载后会看到的目录及本文使用的目录

`rknn-toolkit2`中与本阶段直接相关的目录可以压缩成下面几项：

```text
rknn-toolkit2/
├── doc/                             # 工具链整体文档
├── rknn-toolkit2/
│   ├── doc/                         # Toolkit2安装与转换说明
│   ├── examples/                    # PC端转换示例
│   └── packages/x86_64/             # PC端RKNN Toolkit2的Python wheel
├── rknn-toolkit-lite2/
│   └── packages/                    # 板端Python wheel，本篇最终Demo不使用
└── rknpu2/
    ├── runtime/                     # 板端C/C++ Runtime和头文件
    └── examples/                    # C API示例
```

实际完成YOLO11转换和C++推理时，主要工作位于`rknn_model_zoo`：

```text
rknn_model_zoo/
├── build-linux.sh                       # 统一的Linux C/C++交叉编译入口
├── datasets/COCO/coco_subset_20.txt    # 官方转换脚本默认使用的校准清单
├── 3rdparty/                            # rknn_api.h、librknnrt及图像依赖
├── utils/                               # 图片读取、缩放、绘制等公共代码
└── examples/yolo11/
    ├── README.md                        # 模型下载、转换、构建和运行命令
    ├── model/
    │   ├── download_model.sh            # 下载官方优化版yolo11n.onnx
    │   ├── coco_80_labels_list.txt      # COCO类别名称
    │   └── bus.jpg                      # 官方测试图片
    ├── python/
    │   └── convert.py                   # 官方ONNX转RKNN脚本
    └── cpp/
        ├── CMakeLists.txt               # C++ Demo构建定义
        ├── main.cc                      # 参数、图片读写和结果绘制
        ├── postprocess.cc               # YOLO11解码、阈值筛选和NMS
        ├── yolo11.h                     # RKNN应用上下文和函数声明
        └── rknpu2/yolo11.cc             # RKNPU2平台普通输入推理实现
```

官方`examples/yolo11`目录确实包含`model`、`python`和`cpp`三个分支；`cpp`又把主程序、后处理与RKNPU2推理实现拆开。[YOLO11官方目录](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/yolo11)和[C++官方目录](https://github.com/airockchip/rknn_model_zoo/tree/main/examples/yolo11/cpp)可用于核对当前版本。

### 4.3 在独立Python虚拟环境中安装Toolkit2并准备ONNX

ONNX转换在x86_64 Linux开发电脑上执行。建议为RKNN Toolkit2单独创建一个虚拟环境，与“PT转ONNX”的Ultralytics环境分开。两个环境只通过`.onnx`文件衔接，可以避免PyTorch、ONNX、NumPy和protobuf版本相互覆盖。

Toolkit2安装顺序为：

```text
根据主机Python版本选择对应的cp版本
→ 创建并进入独立虚拟环境
→ 安装requirements_cpXX-<Toolkit版本>.txt
→ 安装相同cp版本的RKNN Toolkit2 wheel
```

`cp38`表示CPython 3.8，`cp310`表示CPython 3.10。选择依据是运行Toolkit2的x86_64主机Python版本，与训练模型时使用的Python版本、开发板Python版本以及是否安装CUDA没有直接关系。下面固定以Python 3.8、RKNN Toolkit2 2.3.2为例；如果本地下载包中的文件名或版本约束不同，应以本地`requirements`和wheel文件名为准。

先创建虚拟环境并升级PIP：

```bash
cd rknn-toolkit2
python3.8 -m venv .venv-rknn
source .venv-rknn/bin/activate

# 使用清华PyPI镜像加速PIP升级；--no-cache-dir避免保留重复下载的安装缓存。
python -m pip install --upgrade pip \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --no-cache-dir
```

无GPU虚拟机应先安装CPU版PyTorch。

`requirements_cp38-2.3.2.txt`包含PyTorch依赖。直接从普通PyPI源解析PyTorch 2.x时，PIP可能继续下载`nvidia-cuda-*`、`nvidia-cudnn-*`等CUDA运行组件。Toolkit2把ONNX转换为RKNN时可以使用CPU，无GPU的VM不需要这些CUDA组件。

如果当前Python 3.8依赖组合要求`torch==2.4.0`和`torchvision==0.19.0`，先明确安装官方CPU wheel：

```bash
# CPU版PyTorch有自己的官方wheel索引。清华PyPI镜像可以加速普通依赖，
# 但把-i改成清华源不能保证得到CPU构建，因此这里保留PyTorch CPU索引。
python -m pip install \
  torch==2.4.0 torchvision==0.19.0 \
  --index-url https://download.pytorch.org/whl/cpu \
  --no-cache-dir
```

该版本组合与[PyTorch官方2.4.0安装说明](https://pytorch.org/get-started/previous-versions/#v240)一致。安装后可以确认当前环境没有启用CUDA：

```bash
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available())"
```

CPU环境的第二行输出应为`False`。这表示PyTorch使用CPU，符合无GPU转换环境的预期。

随后先安装TXT依赖，再安装Toolkit2 wheel。

进入PC端x86_64安装包目录：

```bash
cd rknn-toolkit2/packages/x86_64

# -i使用清华PyPI镜像加速requirements中的普通Python依赖下载。
# 已提前安装的CPU版torch/torchvision满足版本条件时，PIP会继续使用它们。
python -m pip install \
  -r requirements_cp38-2.3.2.txt \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --no-cache-dir

# wheel本身是本地文件；-i只负责加速仍然缺少的在线依赖。
python -m pip install \
  rknn_toolkit2-2.3.2-cp38-cp38-manylinux_2_17_x86_64.manylinux2014_x86_64.whl \
  -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --no-cache-dir
```

TXT必须与wheel的Toolkit版本和`cp`版本一致。安装顺序使用“TXT在前、wheel在后”，可以先让PIP按官方约束准备依赖，再安装本地Toolkit2包。最后验证导入：

```bash
python -c "from rknn.api import RKNN; print('RKNN Toolkit2导入成功')"
```

ONNX文件分为官方测试模型和自己的部署模型两种来源。

没有自己的模型，只想确认转换环境是否可用时，可以下载Rockchip提供的优化版YOLO11n ONNX：

```bash
cd ../../../../rknn_model_zoo/examples/yolo11/model
chmod +x download_model.sh
./download_model.sh
```

`download_model.sh`用于准备官方测试模型。已经使用瑞芯微修改版`ultralytics_yolo11`，把自己的`best.pt`导出为`best.onnx`时，可以跳过这一步。把自己的ONNX放在项目目录中，后续直接把它的路径传给`convert.py`。

瑞芯微修改版导出的检测模型采用适配Model Zoo后处理的多输出结构。若自有模型类别数不是COCO的80类，ONNX输出中的类别通道数会随之变化；转换脚本仍然可以读取它，后续检测后处理和类别名称文件必须使用自己的类别数。[瑞芯微YOLO11适配模型导出说明](https://github.com/airockchip/ultralytics_yolo11/blob/main/RKOPT_README.zh-CN.md)

### 4.4 使用官方convert.py转换自己的ONNX

Rockchip已经在`examples/yolo11/python/convert.py`提供完整转换入口。下面以“自己的不同类别YOLO11模型已经通过瑞芯微修改版导出为`best.onnx`”为主线，不再把官方`yolo11n.onnx`当作实际部署模型。

官方脚本内部仍然是第2节解释的四步主线：

```text
rknn.config(...)
→ rknn.load_onnx(...)
→ rknn.build(...)
→ rknn.export_rknn(...)
```

脚本从命令行读取ONNX路径、目标平台、数据类型和输出路径。它已经检查`load_onnx()`、`build()`与`export_rknn()`的返回值，并在流程末尾调用`release()`。[官方convert.py源码](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/python/convert.py)

官方脚本适合直接完成一次YOLO11模型转换；理解内部代码后，才能在自己的项目里修改输入预处理、校准数据和输出位置。`convert.py`可以分成三个代码模块：

1. `parse_arg()`读取ONNX路径、目标平台、量化类型和输出路径；
2. `RKNN`对象依次执行`config()`、`load_onnx()`、`build()`和`export_rknn()`；
3. 对会返回状态码的`load_onnx()`、`build()`和`export_rknn()`检查返回值，流程结束后调用`release()`释放Toolkit2对象持有的资源。

也就是说，命令行只负责把参数交给转换代码，真正完成模型转换的是这几个RKNN Toolkit2 API。官方脚本适合直接使用；项目需要统一配置管理、批量转换或自动生成精度报告时，可以把相同API整理成自己的函数。

### 4.5 使用官方脚本前需要确认或修改的配置

官方脚本的命令行参数没有包含校准清单路径。转换自己的INT8模型时，`build()`最终会读取`DATASET_PATH`指向的TXT清单。配置自己的校准图片有两种等价做法：修改`convert.py`中的`DATASET_PATH`，或者保留脚本不动并修改它当前指向的TXT文件内容。

第一处是校准清单。源码中的默认值为仓库内COCO子集：

```python
DATASET_PATH = '../../../datasets/COCO/coco_subset_20.txt'
```

保持官方目录结构并在`examples/yolo11/python/`运行时，这个相对路径会指向官方COCO校准清单。它适合验证官方模型转换流程。

第一种做法是修改`convert.py`，让`DATASET_PATH`直接指向自己的清单：

```python
DATASET_PATH = '/home/user/my_yolo/calibration/dataset.txt'
```

第二种做法是不修改`convert.py`，继续保留官方的相对路径，然后打开它所指向的`datasets/COCO/coco_subset_20.txt`，把文件中的图片路径替换成自己的校准图片路径。此时TXT文件名虽然仍带有`COCO`，但Toolkit实际读取的是文件内逐行记录的路径，所以同样可以完成自有数据校准。长期维护项目时，第一种做法的目录含义更清楚；只想快速验证一次转换时，第二种做法也可以。

无论选择哪种做法，清单都需要每行记录一张校准图片。绝对路径最稳妥，可以避免从不同工作目录启动脚本时出现相对路径解析错误：

```text
/home/user/my_yolo/calibration/images/001.jpg
/home/user/my_yolo/calibration/images/002.jpg
/home/user/my_yolo/calibration/images/003.jpg
```

校准只需要图片，不需要YOLO标签文件。图片需要覆盖真实部署中的亮度、背景、目标大小、有目标画面和无目标画面；选择原则已经在阶段4-6第6节说明。瑞芯微修改版导出只调整计算图与输出结构，它没有完成INT8量化，因此`i8`转换仍要使用校准数据。

第二处是输入预处理配置。官方YOLO11脚本把三个通道配置为`mean=0`、`std=255`，对应输入RGB `uint8`、像素范围0～255，并由模型转换配置完成除以255。C++推理代码准备输入时保留`uint8`，不能再手动除以255。

第三处由命令行参数控制：

| 参数 | 作用 | RK3588示例 |
| --- | --- | --- |
| `onnx_model` | 输入自己的ONNX文件 | `/home/user/my_yolo/best.onnx` |
| `platform` | 编译目标NPU | `rk3588` |
| `dtype` | `i8`开启INT8量化，`fp`关闭量化 | `i8` |
| `output_rknn_path` | 导出的RKNN路径 | `/home/user/my_yolo/best.rknn` |

本文假设自有ONNX由瑞芯微修改版`ultralytics_yolo11`导出，其输出结构与相应Model Zoo后处理路径配套。自有模型类别数变化时，需要同步调整后处理中的类别数和类别名称；这些变化不会改变`config → load_onnx → build → export_rknn`转换顺序。

### 4.6 运行官方convert.py完成YOLO11 ONNX转换

前面的环境和校准清单准备完成后，先直接使用官方脚本。回到官方YOLO11 Python目录，执行自有模型的RK3588 INT8转换：

```bash
cd rknn_model_zoo/examples/yolo11/python
python convert.py \
  /home/user/my_yolo/best.onnx \
  rk3588 \
  i8 \
  /home/user/my_yolo/best_int8.rknn
```

四个命令行参数按顺序表示：

1. `/home/user/my_yolo/best.onnx`是待转换的ONNX文件；
2. `rk3588`指定模型将来运行的目标NPU；
3. `i8`让脚本执行INT8量化，`build()`会读取4.5节配置的校准清单；
4. `/home/user/my_yolo/best_int8.rknn`是生成文件的完整路径。

如果只想先验证非INT8转换链路，把第三个参数改成`fp`，同时换一个输出文件名：

```bash
python convert.py \
  /home/user/my_yolo/best.onnx \
  rk3588 \
  fp \
  /home/user/my_yolo/best_fp.rknn
```

两次转换使用同一个ONNX、目标平台、输入尺寸和预处理配置。`i8`版本额外经过校准和INT8量化，`fp`版本跳过INT8量化。官方支持的`dtype`取值随目标平台变化，应以当前`convert.py`打印的用法为准。

命令与官方脚本内部代码的对应关系为：

```text
rk3588
→ config(target_platform="rk3588")

best.onnx
→ load_onnx(model="/home/user/my_yolo/best.onnx")

i8
→ build(do_quantization=True, dataset=DATASET_PATH)

best_int8.rknn
→ export_rknn("/home/user/my_yolo/best_int8.rknn")
```

先掌握这条官方调用命令，已经可以完成正常转换。下一节再拆开脚本内部的四个API，目的是看懂配置应该改在哪里。

### 4.7 独立转换脚本中的关键API、参数与执行结果

官方`convert.py`的核心代码很短，因为计算图读取、量化和NPU编译都封装在RKNN Toolkit2中。下面写一个可以直接运行的`convert_yolo11_to_rknn.py`。文件中直接填写RK3588、ONNX路径、校准清单和输出路径，不通过自定义函数参数继续转交。

在看代码前，先把`config()`中的三个参数讲清楚。

`target_platform="rk3588"`表示`build()`要按照RK3588的NPU能力编译模型。这个字符串描述生成模型的目标芯片，与当前转换电脑使用什么CPU或GPU无关。

`mean_values`和`std_values`用于定义模型输入进入计算图之前的逐通道数值变换。每个输入通道都执行：

$$
y_c=\frac{x_c-\mathrm{mean}_c}{\mathrm{std}_c}
$$

其中，$x_c$是某个通道送入RKNN模型的原始数值，$c$表示通道位置，$y_c$是交给ONNX计算图的数值。对于下面的YOLO11配置：

```python
mean_values=[[0, 0, 0]]
std_values=[[255, 255, 255]]
```

最外层列表表示“模型的第一个输入”，内层三个数依次对应图像输入的三个通道。每个通道先减0，再除以255。因此，输入值128进入计算图前会变成：

$$
\frac{128-0}{255}\approx 0.502
$$

这里的`std_values`在这条配置中承担逐通道除数的作用。数值255来自YOLO11将0～255像素转换到0～1范围的预处理约定。

这组配置只完成减均值和除标准值。图片缩放、letterbox和通道顺序转换仍由输入准备代码完成。本例向RKNN Runtime提交RGB、`uint8`、0～255的图片数据，模型配置再完成除以255。若应用程序已经把输入手动除以255，继续使用`std_values=[[255, 255, 255]]`会再次除以255，输入范围将错误地缩小到约0～0.00392。

```python
from rknn.api import RKNN

# verbose=True让Toolkit2输出详细的读取、量化和编译日志。
# rknn保存本次转换的配置状态和内存模型，最后必须调用release()释放。
rknn = RKNN(verbose=True)

try:
    # 目标平台直接固定为RK3588。
    # 三通道输入分别执行(input - 0) / 255，把uint8像素转换到0～1范围。
    rknn.config(
        mean_values=[[0, 0, 0]],
        std_values=[[255, 255, 255]],
        target_platform="rk3588",
    )

    # 直接读取自己的YOLO11 ONNX。成功表示模型已进入Toolkit2内存，
    # 目标NPU能否接受全部图结构还要等build()完成后才能确定。
    ret = rknn.load_onnx(model="/home/user/my_yolo/best.onnx")
    if ret != 0:
        raise RuntimeError(f"load_onnx failed, ret={ret}")

    # 这里固定生成INT8模型。dataset指向校准图片清单，
    # build()会读取清单中的图片，统计激活范围，再完成量化和RK3588编译。
    ret = rknn.build(
        do_quantization=True,
        dataset="/home/user/my_yolo/calibration/dataset.txt",
    )
    if ret != 0:
        raise RuntimeError(f"build failed, ret={ret}")

    # 把内存中的编译结果直接写到指定位置。
    # export_rknn()成功只代表文件写出成功，推理精度需要另行分析。
    ret = rknn.export_rknn("/home/user/my_yolo/best_int8.rknn")
    if ret != 0:
        raise RuntimeError(f"export_rknn failed, ret={ret}")

    print("RKNN模型已经生成：/home/user/my_yolo/best_int8.rknn")
finally:
    # 正常结束或中途抛出异常都会执行这里，避免转换资源一直留在进程中。
    rknn.release()
```

四个关键API的作用和参数关系如下：

| API | 直接作用 | 本例关键参数 | 成功后得到什么 |
| --- | --- | --- | --- |
| `rknn.config()` | 保存目标平台、输入归一化和量化相关的全局配置 | `target_platform`、`mean_values`、`std_values` | 后续加载和构建共同使用的配置状态 |
| `rknn.load_onnx()` | 把ONNX图、权重和输入输出接口读入Toolkit2 | `model` | 内存中的待转换模型；此时尚未完成NPU编译 |
| `rknn.build()` | 执行图优化、可选量化校准和目标NPU编译 | `do_quantization`、`dataset` | 内存中的已编译RKNN模型 |
| `rknn.export_rknn()` | 把已编译模型写入磁盘 | RKNN输出路径 | 可以复制到板端加载的`.rknn`文件 |

`load_onnx(model=...)`最常用的参数就是模型路径。Toolkit2还支持为特定模型指定输入等附加信息，固定输入的YOLO11通常不需要额外覆盖。模型能否在RK3588上编译，最终由`build()`的返回值和日志确认。

`build(do_quantization=True, dataset=...)`生成INT8模型时，`dataset`必须指向可读取的校准清单。`do_quantization=False`生成的是非INT8 RKNN模型；它经过Toolkit2的图优化和平台编译，因此这里把它称为“非INT8模型”，不能假定所有计算都保持ONNX中的FP32形式。

`export_rknn()`只负责保存`build()`已经产生的结果。输出目录需要提前存在，返回非0时不应把目标文件交给板端程序。

### 4.8 使用accuracy_analysis生成浮点参考与INT8模拟的逐层误差文件

`accuracy_analysis()`比较同一输入在浮点参考路径和INT8量化模拟路径中的逐层张量，并把误差总表和张量文件写入目录。本节分析范围到模型各层的数值为止，生成内容不包含YOLO后处理结果。

调用顺序固定为：使用与正式转换相同的`config()`配置读取ONNX，执行`build(do_quantization=True, ...)`，然后调用`accuracy_analysis()`。官方示例也采用这个顺序。[RKNN Toolkit2精度分析示例](https://github.com/airockchip/rknn-toolkit2/blob/master/rknn-toolkit2/examples/functions/accuracy_analysis/test.py)

下面是可以直接运行的`analyze_quantization.py`。脚本中的ONNX路径、校准清单、分析图片、RK3588平台和输出目录都直接写在对应API中：

```python
from pathlib import Path
from rknn.api import RKNN

# 在开始构建前分别确认三个输入文件存在。
# 分析图片只提供一次固定输入，不需要YOLO标签文件。
if not Path("/home/user/my_yolo/best.onnx").is_file():
    raise FileNotFoundError("找不到ONNX：/home/user/my_yolo/best.onnx")
if not Path("/home/user/my_yolo/calibration/dataset.txt").is_file():
    raise FileNotFoundError("找不到校准清单：/home/user/my_yolo/calibration/dataset.txt")
if not Path("/home/user/my_yolo/test.jpg").is_file():
    raise FileNotFoundError("找不到分析图片：/home/user/my_yolo/test.jpg")

# verbose=True会把逐层分析过程和误差表同时打印到终端。
rknn = RKNN(verbose=True)

try:
    # 这里完整复制正式INT8转换使用的配置。
    # RK3588、mean和std只要有一项不同，报告就不能代表正式转换模型。
    rknn.config(
        mean_values=[[0, 0, 0]],
        std_values=[[255, 255, 255]],
        target_platform="rk3588",
    )

    # 读取与正式转换相同的YOLO11 ONNX。
    ret = rknn.load_onnx(model="/home/user/my_yolo/best.onnx")
    if ret != 0:
        raise RuntimeError(f"load_onnx failed, ret={ret}")

    # 逐层比较需要先构建INT8模拟路径。
    # dataset必须与正式INT8模型使用同一份校准清单。
    ret = rknn.build(
        do_quantization=True,
        dataset="/home/user/my_yolo/calibration/dataset.txt",
    )
    if ret != 0:
        raise RuntimeError(f"quantized build failed, ret={ret}")

    # Toolkit2使用test.jpg分别得到浮点参考张量和INT8模拟张量。
    # output_dir指定整个报告文件夹；目录中会写入总表、名称映射和逐层数据。
    ret = rknn.accuracy_analysis(
        inputs=["/home/user/my_yolo/test.jpg"],
        output_dir="/home/user/my_yolo/snapshot_yolo11_int8",
    )
    if ret != 0:
        raise RuntimeError(f"accuracy_analysis failed, ret={ret}")

    print("量化误差报告已经生成：/home/user/my_yolo/snapshot_yolo11_int8")
finally:
    # 分析成功或失败都释放Toolkit2资源；已经写入磁盘的报告文件会保留。
    rknn.release()
```

把代码保存为`analyze_quantization.py`后，在安装了RKNN Toolkit2的PC虚拟环境中运行：

```bash
python analyze_quantization.py
```

典型输出目录如下。不同Toolkit2版本生成的附加文件可能变化，下面四类内容是当前分析的主线：

```text
snapshot_yolo11_int8/
├── error_analysis.txt       # 每层的累计误差与单层误差总表
├── map_name_to_file.txt     # 模型层名到磁盘文件名的映射
├── golden/                  # 浮点参考模型的逐层张量
│   └── npy/                 # 保留原始张量shape的NumPy文件
└── simulator/               # INT8量化模拟器的逐层张量
    └── npy/                 # 与golden/npy中的同名文件逐项对应
```

`golden`表示同一ONNX的浮点参考值，`simulator`表示INT8量化模拟值。它们不要求用户先分别导出两个RKNN文件；`accuracy_analysis()`在一次量化分析流程中生成两套对照数据。该报告主要定位PC侧量化误差，最终仍要在验证集上比较mAP等任务指标。

先打开`error_analysis.txt`。表中的`cos`是余弦相似度，越接近1表示两个张量方向越接近；`euc`是欧氏距离，越接近0表示数值距离越小。不同层的元素数量和数值范围不同，不能只按`euc`绝对值跨层排序，排查时优先结合`cos`和前后层变化。

报告同时给出两组误差：

- `entire`比较浮点参考路径与完整INT8模拟路径，包含前面各层逐步积累的误差；
- `single`尽量只衡量当前层自身引入的量化误差，更适合寻找量化敏感层。

官方说明也把`entire`定义为逐层累计误差，把`single`用于反映当前层精度。[accuracy_analysis输出说明](https://github.com/airockchip/rknn-toolkit2/blob/master/rknn-toolkit2/examples/functions/accuracy_analysis/README.md)

YOLO11应先看检测头末端的输出，再向前检查中间层。瑞芯微优化版YOLO11通常按80×80、40×40和20×20三个尺度输出回归、分类及辅助分数张量；实际输出名称以自己的`error_analysis.txt`和`map_name_to_file.txt`为准。检查顺序如下：

1. 在报告末端找到三个尺度的输出，先看它们的`entire cos`，确定哪个尺度差异最大；
2. 若最终输出差异明显，向该输出依赖的前几层移动，寻找`entire cos`第一次明显下降的位置；
3. 再看该位置的`single cos`。`entire`降低而`single`仍接近1，说明误差主要由前层累积；二者同时明显降低时，当前层更值得作为量化敏感层检查；
4. 通过`map_name_to_file.txt`找到对应文件，在`golden/npy`与`simulator/npy`中读取同名`.npy`，比较shape、数值范围、平均绝对误差和最大绝对误差。

例如，已经从映射文件中确定某个检测头输出对应`505.npy`时，可以直接比较两份张量：

```python
import numpy as np

# .npy保留原始张量shape，适合继续按通道和特征图位置排查。
golden = np.load("snapshot_yolo11_int8/golden/npy/505.npy")
simulator = np.load("snapshot_yolo11_int8/simulator/npy/505.npy")

# 两个数组来自同一层，shape应完全一致；不一致时应先检查文件映射是否选错。
if golden.shape != simulator.shape:
    raise ValueError(f"张量shape不一致：{golden.shape} != {simulator.shape}")

absolute_error = np.abs(golden.astype(np.float32) - simulator.astype(np.float32))

print("shape：", golden.shape)
print("浮点参考范围：", float(golden.min()), float(golden.max()))
print("INT8模拟范围：", float(simulator.min()), float(simulator.max()))
print("平均绝对误差：", float(absolute_error.mean()))
print("最大绝对误差：", float(absolute_error.max()))

# 找到误差最大的一个元素，并恢复成该张量原始的多维索引。
# 这个索引用于继续查看具体通道和特征图位置。
flat_index = int(np.argmax(absolute_error))
tensor_index = np.unravel_index(flat_index, absolute_error.shape)
print("最大误差位置：", tensor_index)
print("该位置浮点值：", float(golden[tensor_index]))
print("该位置INT8值：", float(simulator[tensor_index]))
```

这份报告只回答两件事：模型最后几个输出张量相差多少，以及误差从哪一个中间层开始明显增加。它不会生成类别、置信度或坐标等YOLO后处理结果。

### 4.9 转换与分析结果如何进入后续C++构建和板端运行

本文的自有模型转换成功后位于：

```text
/home/user/my_yolo/best_int8.rknn
```

这个文件已经包含面向RK3588编译后的模型。后续可以把它复制到自己的C++项目资源目录，或者直接复制到板端并把路径交给`rknn_init()`。第6节的自写Demo使用文件名`best.rknn`，复制时可以把`best_int8.rknn`重命名为`best.rknn`，也可以把Demo中的模型路径改为实际文件名。`snapshot_yolo11_int8`是PC端分析目录，板端运行只需要`.rknn`模型、Runtime库和应用程序，不需要把该分析目录复制到开发板。

如果要先运行官方C++ Demo做对照，可以把`best_int8.rknn`复制到`examples/yolo11/model/`，再使用官方`build-linux.sh`。该脚本根据`-d yolo11`定位`examples/yolo11/cpp/CMakeLists.txt`，链接`librknnrt`和官方公共图像工具，并把`.rknn`模型安装进`install/`目录。[官方CMakeLists.txt](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/cpp/CMakeLists.txt)和[build-linux.sh](https://github.com/airockchip/rknn_model_zoo/blob/main/build-linux.sh)给出了这条参考路径。

## 5 RK3588板端C++程序使用RKNN Runtime的方法

### 5.1 官方C++源码按职责拆分的方式

官方C++ Demo已经把不同职责放进不同文件：

| 文件或目录 | 主要职责 | 与RKNN Runtime的关系 |
| --- | --- | --- |
| `cpp/rknpu2/yolo11.cc` | 加载模型、查询张量、设置输入、运行、取回输出、释放Runtime | RKNN主线 |
| `cpp/yolo11.h` | 保存`rknn_context`、输入输出属性和模型尺寸 | RKNN主线的数据结构 |
| `cpp/main.cc` | 解析路径、读图、调用推理、画框、保存图片 | 应用层组织 |
| `cpp/postprocess.cc` | DFL解码、置信度筛选、NMS、坐标还原 | YOLO算法后处理 |
| `utils/` | 图片读取、letterbox、绘制和文件操作 | 通用图像与文件工具 |

因此，学习RKNN API时先看`rknpu2/yolo11.cc`；学习YOLO输出时再看`postprocess.cc`；图片解码和绘制留在`main.cc`与`utils/`。这样可以避免把OpenCV、NMS或图片格式处理误认为RKNN Runtime的功能。

### 5.2 自建C++项目需要的RKNN头文件、动态库与模型文件

在RK3588上运行RKNN模型，自己的C++工程只需要接入RKNN Runtime主线所依赖的内容：

| 内容 | 来源 | 在项目中的作用 |
| --- | --- | --- |
| `rknn_api.h` | `rknn-toolkit2-2.3.2/rknpu2/runtime/Linux/librknn_api/include/` | 声明`rknn_init()`、`rknn_query()`、`rknn_run()`等C接口，以及张量描述结构体和枚举 |
| `librknnrt.so` | `rknn-toolkit2-2.3.2/rknpu2/runtime/Linux/librknn_api/aarch64/` | RK3588的AArch64动态库，程序链接和板端运行时都需要它 |
| 自己转换得到的`.rknn`文件 | 第4节的转换结果 | 保存面向RK3588编译后的网络、权重和量化信息 |
| RK3588系统中的RKNPU驱动 | 开发板系统镜像或驱动包 | 接收Runtime提交的任务并控制NPU执行；它不复制进普通应用源码目录 |

表中的头文件和AArch64动态库路径可以在[RKNPU2官方Runtime目录](https://github.com/airockchip/rknn-toolkit2/tree/master/rknpu2/runtime/Linux/librknn_api)中确认。编译时通过`-I`指定`rknn_api.h`所在目录，通过`-L`指定动态库目录并使用`-lrknnrt`链接。板端启动程序时，动态加载器还要能找到`librknnrt.so`；可以把它安装到系统库目录，或者把项目的`lib/`目录加入`LD_LIBRARY_PATH`。

如果程序还要读图、缩放、填充和绘制，可以另外链接OpenCV。OpenCV只处理图像，RKNN Runtime本身不依赖它完成模型执行。YOLO的DFL解码、置信度筛选和非极大值抑制（Non-Maximum Suppression，NMS）也属于应用后处理，需要自己实现或有选择地移植官方`postprocess.cc`。

一个最小自建工程可以按下面组织：

```text
my_rknn_app/
├── CMakeLists.txt
├── include/
│   └── rknn_api.h
├── lib/
│   └── librknnrt.so
├── model/
│   └── best.rknn
└── src/
    └── main.cc
```

这里不需要复制Model Zoo中的全部`utils/`、图片结构体和公共头文件。只有当自己的代码直接调用了其中的函数时，才需要把对应源码及其依赖一起移植。官方YOLO11的`postprocess.cc`还要配合`postprocess.h`、模型常量和辅助函数使用，单独复制这个`.cc`文件无法直接构成完整后处理模块。实际项目可以参考它的输出解码逻辑，再用自己的数据结构实现后处理。

需要注意版本匹配：`rknn_api.h`和`librknnrt.so`应来自同一套RKNPU2发布包，板端RKNPU驱动也要满足该Runtime版本的要求。程序启动后可以通过官方头文件定义的`rknn_query(..., RKNN_QUERY_SDK_VERSION, ...)`读取API与驱动版本，排查头文件、动态库和驱动组合不一致的问题。[rknn_api.h](https://github.com/airockchip/rknn-toolkit2/blob/master/rknpu2/runtime/Linux/librknn_api/include/rknn_api.h)

### 5.3 使用rknn_init与rknn_query初始化模型并确认输入输出

自己的程序启动后，先把`.rknn`文件完整读入一段连续内存，再调用`rknn_init()`创建运行上下文：

```cpp
rknn_context context = 0;
int ret = rknn_init(&context, model_buffer.data(),
                    static_cast<uint32_t>(model_buffer.size()), 0, nullptr);
if (ret != RKNN_SUCC) {
    // 初始化失败时context不可用于后续查询或推理，调用者应结束当前加载流程。
    std::cerr << "rknn_init failed, ret=" << ret << '\n';
    return -1;
}
```

`rknn_context`是Runtime返回的模型上下文句柄。后面的查询、输入设置、推理和输出获取都要使用同一个句柄。普通加载方式下，`rknn_init()`成功返回后，应用保存模型文件内容的`model_buffer`可以释放；上下文则要一直保留到最后一次推理结束。

初始化成功后调用`rknn_query()`读取模型的真实接口信息。先查询输入输出数量，再逐个设置属性结构体的`index`并查询对应张量：

```cpp
rknn_input_output_num io_num{};
ret = rknn_query(context, RKNN_QUERY_IN_OUT_NUM, &io_num, sizeof(io_num));
if (ret != RKNN_SUCC) {
    // 查询失败说明当前上下文不能可靠描述模型接口，需要销毁context并停止推理。
    std::cerr << "query input/output number failed, ret=" << ret << '\n';
    rknn_destroy(context);
    return -1;
}

std::vector<rknn_tensor_attr> input_attrs(io_num.n_input);
for (uint32_t index = 0; index < io_num.n_input; ++index) {
    input_attrs[index] = {};
    input_attrs[index].index = index;
    ret = rknn_query(context, RKNN_QUERY_INPUT_ATTR,
                     &input_attrs[index], sizeof(rknn_tensor_attr));
    if (ret != RKNN_SUCC) {
        // 任意输入属性缺失都会影响缓冲区尺寸和布局判断，因此不能继续提交输入。
        std::cerr << "query input attr failed, index=" << index << '\n';
        rknn_destroy(context);
        return -1;
    }
}
```

输出属性按同样方式使用`RKNN_QUERY_OUTPUT_ATTR`查询。应用重点读取`n_dims`和`dims`确认shape，读取`fmt`确认NCHW或NHWC布局，读取`type`确认数据类型，并在量化输出后处理中使用`zp`与`scale`。模型尺寸、输出数量或类型应以查询结果为准，不能只依赖写在源码中的固定值。

### 5.4 使用rknn_inputs_set、rknn_run与rknn_outputs_get完成一次推理

完成图像预处理后，应用先用`rknn_input`描述内存中的输入张量，再把它交给当前上下文。下面以单输入、RGB、NHWC、`uint8`模型为例：

```cpp
rknn_input input{};
input.index = 0;                         // 对应查询结果中的第0个模型输入。
input.type = RKNN_TENSOR_UINT8;          // 缓冲区每个通道占1字节，数值范围为0～255。
input.fmt = RKNN_TENSOR_NHWC;            // 内存顺序为高度、宽度、通道。
input.size = input_rgb.total() * input_rgb.elemSize();
input.buf = input_rgb.data;              // Runtime在本次同步推理期间读取这段OpenCV图像内存。
input.pass_through = 0;                   // 允许Runtime按模型配置完成必要的数据转换。

ret = rknn_inputs_set(context, 1, &input);
if (ret != RKNN_SUCC) {
    // 输入没有绑定成功，本次推理尚未提交，图像缓冲区仍由应用自己管理。
    std::cerr << "rknn_inputs_set failed, ret=" << ret << '\n';
    return -1;
}

ret = rknn_run(context, nullptr);
if (ret != RKNN_SUCC) {
    // NPU执行失败时没有可供后处理的有效输出，不能继续调用检测框解码。
    std::cerr << "rknn_run failed, ret=" << ret << '\n';
    return -1;
}
```

这里的`input_rgb`必须已经满足模型查询结果要求的宽、高、颜色通道和布局。第4.5节采用`mean=0`、`std=255`时，应用传入0～255的`uint8` RGB图像；Runtime根据模型中的配置完成归一化。若应用又手动除以255，输入会被重复缩放，检测结果会明显异常。

NPU执行成功后，按实际输出数量创建`rknn_output`数组并获取结果：

```cpp
std::vector<rknn_output> outputs(io_num.n_output);
for (uint32_t index = 0; index < io_num.n_output; ++index) {
    outputs[index] = {};
    outputs[index].index = index;
    outputs[index].want_float = 1;
    // want_float=1要求Runtime返回float数据，便于最小程序观察输出；
    // 追求性能时可保留量化输出，并结合查询到的zp和scale自行解释数值。
}

ret = rknn_outputs_get(context, io_num.n_output, outputs.data(), nullptr);
if (ret != RKNN_SUCC) {
    // 获取失败时outputs中的buf不能交给后处理使用。
    std::cerr << "rknn_outputs_get failed, ret=" << ret << '\n';
    return -1;
}
```

`rknn_outputs_get()`成功后，每个`outputs[index].buf`才指向有效输出。YOLO后处理在这些缓冲区有效期间完成解码、阈值筛选、NMS和坐标还原。`want_float=1`适合先打通流程；量化模型追求更低的转换开销时，可以令其为0，并根据输出属性中的数据类型、`zp`和`scale`读取原始量化值。

### 5.5 输出缓冲区与RKNN上下文的释放顺序

Runtime输出缓冲区的有效期从`rknn_outputs_get()`成功开始，到`rknn_outputs_release()`调用为止。后处理必须放在这两个调用之间：

```text
rknn_outputs_get()成功
→ 自己的YOLO后处理读取outputs[index].buf
→ 后处理把结果复制到应用自己的检测框容器
→ rknn_outputs_release()归还Runtime输出
→ 下一张图片可以继续复用同一个context推理
```

释放输出时要传入与获取时相同的数量和数组：

```cpp
ret = rknn_outputs_release(context, io_num.n_output, outputs.data());
if (ret != RKNN_SUCC) {
    // 释放失败可能造成Runtime资源无法正常复用，应记录错误并停止继续循环推理。
    std::cerr << "rknn_outputs_release failed, ret=" << ret << '\n';
}

// 所有图片都处理完以后再销毁context；销毁后不能继续使用此前查询到的运行上下文。
rknn_destroy(context);
context = 0;
```

应用自己的检测框、类别和置信度容器由应用管理，可以在释放RKNN输出后继续使用。任何仍指向`outputs[index].buf`的指针都会在释放后失效。长时间视频推理时，模型上下文应初始化一次并重复用于每一帧；每一轮都成对执行`rknn_outputs_get()`与`rknn_outputs_release()`，程序退出时再执行一次`rknn_destroy()`。

## 6 自行编写最小C++程序完成YOLO11n RKNN单图推理

Rockchip已经提供完整Linux C++ Demo，可以用它确认官方模型、Runtime和驱动能够协同运行。官方工程中的`rknpu2/yolo11.cc`负责RKNN调用，`main.cc`负责应用流程，`utils/`负责图片处理，`postprocess.cc`负责DFL解码和NMS。[官方C++入口](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/cpp/main.cc)与[官方RKNPU2推理实现](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/cpp/rknpu2/yolo11.cc)可作为对照。

下面不运行官方Demo，自己写一个只依赖OpenCV、`rknn_api.h`和`librknnrt.so`的最小程序。它完成一次真实NPU推理并打印九个输出张量的信息。检测框解码暂时不放进这个程序，因为DFL、NMS和类别名称属于YOLO后处理；后续可以把它们写进独立的`postprocess.cc`，接收本Demo取得的输出。

目录如下：

```text
minimal_yolo11_rknn/
├── main.cc
├── image_process.hpp
├── best.rknn
├── test.jpg
└── third_party/rknn/
    ├── include/rknn_api.h
    └── lib/librknnrt.so
```

### 6.1 图片预处理独立保存在image_process.hpp

当前转换配置使用RGB输入、NHWC布局、`uint8`类型和0～255像素范围；除以255已经写入RKNN转换配置。`prepare_yolo_input()`只负责OpenCV读图后的letterbox与BGR转RGB，不调用任何RKNN接口。

```cpp
#pragma once

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include <opencv2/imgproc.hpp>

// 把OpenCV读取的BGR原图转换为模型输入。
// 输入：bgr_image为HWC排列的BGR uint8图像；target_width和target_height
//       来自rknn_query()返回的模型输入属性，单位为像素。
// 输出：连续存储的HWC RGB uint8图像，尺寸固定为模型输入尺寸。
// 本函数不执行除以255，因为转换脚本中的mean=0、std=255已经承担该步骤。
inline cv::Mat prepare_yolo_input(
    const cv::Mat& bgr_image,
    int target_width,
    int target_height) {
    if (bgr_image.empty()) {
        throw std::invalid_argument("输入图片为空");
    }
    if (target_width <= 0 || target_height <= 0) {
        throw std::invalid_argument("模型输入尺寸无效");
    }

    // 使用横向和纵向缩放比例中的较小值，保证整张原图进入目标画布。
    const double scale = std::min(
        static_cast<double>(target_width) / bgr_image.cols,
        static_cast<double>(target_height) / bgr_image.rows);
    const int resized_width =
        static_cast<int>(std::round(bgr_image.cols * scale));
    const int resized_height =
        static_cast<int>(std::round(bgr_image.rows * scale));

    cv::Mat resized;
    cv::resize(
        bgr_image,
        resized,
        cv::Size(resized_width, resized_height),
        0.0,
        0.0,
        cv::INTER_LINEAR);

    // 114是YOLO常用letterbox填充值。缩放图居中放入画布，未覆盖区域
    // 保持114；后续增加坐标还原时还要把left和top传给后处理模块。
    cv::Mat canvas(
        target_height,
        target_width,
        CV_8UC3,
        cv::Scalar(114, 114, 114));
    const int left = (target_width - resized_width) / 2;
    const int top = (target_height - resized_height) / 2;
    resized.copyTo(
        canvas(cv::Rect(left, top, resized_width, resized_height)));

    // OpenCV输入是BGR，当前模型输入是RGB。cvtColor生成新的连续图像；
    // 若具体OpenCV实现返回非连续矩阵，clone()会复制为连续缓冲区。
    cv::Mat rgb_image;
    cv::cvtColor(canvas, rgb_image, cv::COLOR_BGR2RGB);
    if (!rgb_image.isContinuous()) {
        rgb_image = rgb_image.clone();
    }
    return rgb_image;
}
```

### 6.2 RKNN Runtime调用集中保存在main.cc

这个`main.cc`只做五件事：读取RKNN文件、查询模型接口、准备一张输入图、执行NPU推理、打印输出。为了缩小Demo范围，`rknn_outputs_get()`设置`want_float=1`，让Runtime把量化输出转换为FP32后返回；这会增加一次输出转换开销，适合先跑通流程。正式项目可以直接取得INT8输出，再由独立后处理使用每个输出的`zero-point`和`scale`解量化。

```cpp
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

#include <opencv2/imgcodecs.hpp>

#include "rknn_api.h"
#include "image_process.hpp"


// 一次性读取RKNN模型文件。
// 返回vector持有模型字节；该vector在main()结束前一直有效，因此传给
// rknn_init()的data()指针在初始化期间不会失效。
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path, std::ios::binary | std::ios::ate);
    if (!file) {
        throw std::runtime_error("无法打开RKNN模型：" + path);
    }

    const std::streamsize file_size = file.tellg();
    if (file_size <= 0) {
        throw std::runtime_error("RKNN模型文件为空：" + path);
    }

    std::vector<std::uint8_t> data(static_cast<std::size_t>(file_size));
    file.seekg(0, std::ios::beg);
    if (!file.read(
            reinterpret_cast<char*>(data.data()),
            file_size)) {
        throw std::runtime_error("读取RKNN模型失败：" + path);
    }
    return data;
}


// 打印张量shape。dims的排列含义需要结合attr.fmt判断；本Demo主要用它
// 确认Rockchip优化版YOLO11是否返回预期的九个输出。
void print_tensor_shape(
    const char* prefix,
    const rknn_tensor_attr& attr) {
    std::cout << prefix << attr.index << " shape=[";
    for (std::uint32_t i = 0; i < attr.n_dims; ++i) {
        if (i != 0) {
            std::cout << ", ";
        }
        std::cout << attr.dims[i];
    }
    std::cout << "] type=" << attr.type
              << " fmt=" << attr.fmt
              << " zp=" << attr.zp
              << " scale=" << attr.scale
              << '\n';
}


// 独占持有一个rknn_context。rknn_init()成功后，无论main()从哪个异常
// 路径退出，析构函数都会调用rknn_destroy()，避免遗漏Runtime资源释放。
class RknnContextGuard {
public:
    RknnContextGuard() = default;
    RknnContextGuard(const RknnContextGuard&) = delete;
    RknnContextGuard& operator=(const RknnContextGuard&) = delete;

    ~RknnContextGuard() {
        if (context_ != 0) {
            rknn_destroy(context_);
        }
    }

    // 只在rknn_init()时暴露句柄地址，让该函数写入新创建的context。
    rknn_context* out_parameter() {
        return &context_;
    }

    // 其他RKNN接口只取得句柄值，不获得context的销毁责任。
    rknn_context get() const {
        return context_;
    }

private:
    rknn_context context_ = 0;
};


int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "用法：" << argv[0]
                  << " <model.rknn> <image.jpg>\n";
        return 1;
    }

    const std::string model_path = argv[1];
    const std::string image_path = argv[2];

    try {
        std::vector<std::uint8_t> model_data =
            read_binary_file(model_path);
        if (model_data.size() >
            std::numeric_limits<std::uint32_t>::max()) {
            throw std::runtime_error("RKNN模型大小超过rknn_init参数范围");
        }

        // context_guard独占Runtime上下文；成功初始化后，所有退出路径都会
        // 由它的析构函数调用rknn_destroy()。
        RknnContextGuard context_guard;
        int ret = rknn_init(
            context_guard.out_parameter(),
            model_data.data(),
            static_cast<std::uint32_t>(model_data.size()),
            0,
            nullptr);
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "rknn_init失败，返回值=" + std::to_string(ret));
        }

        rknn_input_output_num io_num{};
        ret = rknn_query(
            context_guard.get(),
            RKNN_QUERY_IN_OUT_NUM,
            &io_num,
            sizeof(io_num));
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "查询输入输出数量失败，返回值=" + std::to_string(ret));
        }
        if (io_num.n_input != 1 || io_num.n_output != 9) {
            throw std::runtime_error(
                "本Demo要求1输入、9输出，实际为" +
                std::to_string(io_num.n_input) + "输入、" +
                std::to_string(io_num.n_output) + "输出");
        }

        // 查询唯一输入的layout和shape。应用程序使用查询值准备图片，避免
        // 把640×640或NCHW/NHWC假设散落在代码其他位置。
        rknn_tensor_attr input_attr{};
        input_attr.index = 0;
        ret = rknn_query(
            context_guard.get(),
            RKNN_QUERY_INPUT_ATTR,
            &input_attr,
            sizeof(input_attr));
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "查询输入属性失败，返回值=" + std::to_string(ret));
        }
        print_tensor_shape("input", input_attr);

        int input_height = 0;
        int input_width = 0;
        int input_channels = 0;
        if (input_attr.fmt == RKNN_TENSOR_NCHW) {
            input_channels = input_attr.dims[1];
            input_height = input_attr.dims[2];
            input_width = input_attr.dims[3];
        } else if (input_attr.fmt == RKNN_TENSOR_NHWC) {
            input_height = input_attr.dims[1];
            input_width = input_attr.dims[2];
            input_channels = input_attr.dims[3];
        } else {
            throw std::runtime_error("当前Demo不支持该输入layout");
        }
        if (input_channels != 3) {
            throw std::runtime_error("当前Demo只处理三通道图像输入");
        }

        // 输出属性在推理前查询并保存。后续自写postprocess.cc时，需要用
        // 这些shape、dtype、zero-point和scale解释每个输出缓冲区。
        std::vector<rknn_tensor_attr> output_attrs(io_num.n_output);
        for (std::uint32_t i = 0; i < io_num.n_output; ++i) {
            output_attrs[i].index = i;
            ret = rknn_query(
                context_guard.get(),
                RKNN_QUERY_OUTPUT_ATTR,
                &output_attrs[i],
                sizeof(output_attrs[i]));
            if (ret != RKNN_SUCC) {
                throw std::runtime_error(
                    "查询输出属性失败，索引=" + std::to_string(i));
            }
            print_tensor_shape("output", output_attrs[i]);
        }

        cv::Mat bgr_image = cv::imread(
            image_path,
            cv::IMREAD_COLOR);
        if (bgr_image.empty()) {
            throw std::runtime_error("OpenCV无法读取图片：" + image_path);
        }
        cv::Mat rgb_input = prepare_yolo_input(
            bgr_image,
            input_width,
            input_height);

        // pass_through=0允许Runtime按照输入描述处理layout和类型转换。
        // buf由rgb_input持有；rknn_inputs_set()和rknn_run()完成前，
        // rgb_input仍位于当前作用域，因此该指针保持有效。
        rknn_input input{};
        input.index = 0;
        input.type = RKNN_TENSOR_UINT8;
        input.fmt = RKNN_TENSOR_NHWC;
        input.pass_through = 0;
        input.size = static_cast<std::uint32_t>(
            rgb_input.total() * rgb_input.elemSize());
        input.buf = rgb_input.data;

        ret = rknn_inputs_set(context_guard.get(), 1, &input);
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "设置输入失败，返回值=" + std::to_string(ret));
        }

        // rknn_run()把当前输入对应的计算任务提交给NPU。返回成功后，
        // 当前context中已经存在本次推理的输出，可以继续获取。
        ret = rknn_run(context_guard.get(), nullptr);
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "NPU推理失败，返回值=" + std::to_string(ret));
        }

        std::vector<rknn_output> outputs(io_num.n_output);
        for (std::uint32_t i = 0; i < io_num.n_output; ++i) {
            outputs[i].index = i;
            outputs[i].want_float = 1;
            outputs[i].is_prealloc = 0;
        }

        // Runtime为每个输出分配缓冲区。取得成功后，应用程序拥有临时
        // 使用权；打印或后处理结束后必须调用rknn_outputs_release()归还。
        ret = rknn_outputs_get(
            context_guard.get(),
            io_num.n_output,
            outputs.data(),
            nullptr);
        if (ret != RKNN_SUCC) {
            throw std::runtime_error(
                "取得输出失败，返回值=" + std::to_string(ret));
        }

        for (std::uint32_t i = 0; i < io_num.n_output; ++i) {
            std::cout << "output" << i
                      << " returned_bytes=" << outputs[i].size;
            if (outputs[i].buf != nullptr &&
                outputs[i].size >= sizeof(float)) {
                const float first_value =
                    static_cast<const float*>(outputs[i].buf)[0];
                std::cout << " first_float=" << first_value;
            }
            std::cout << '\n';
        }

        // outputs_release使outputs[i].buf失效；之后不能再读取这些地址。
        // rknn_destroy随后销毁模型context，完成本Demo的资源生命周期。
        rknn_outputs_release(
            context_guard.get(),
            io_num.n_output,
            outputs.data());
    } catch (const std::exception& error) {
        std::cerr << "运行失败：" << error.what() << '\n';
        return 1;
    }

    return 0;
}
```

这个最小程序可以直接在已经安装C++编译器和OpenCV开发包的RK3588 Linux板端编译。自己的项目只需要从SDK复制`rknn_api.h`和`librknnrt.so`，不需要复制Model Zoo的全部头文件。它们位于RKNN Toolkit2仓库的`rknpu2/runtime/Linux/librknn_api/`下，并且必须与板端驱动、转换工具版本匹配。[RKNN Runtime官方目录](https://github.com/airockchip/rknn-toolkit2/tree/master/rknpu2/runtime/Linux/librknn_api)

```bash
g++ -std=c++17 main.cc \
  -Ithird_party/rknn/include \
  -Lthird_party/rknn/lib \
  $(pkg-config --cflags --libs opencv4) \
  -lrknnrt -ldl \
  -o minimal_yolo11_rknn
```

运行时把项目内的动态库目录加入当前进程的搜索路径：

```bash
LD_LIBRARY_PATH=third_party/rknn/lib \
  ./minimal_yolo11_rknn best.rknn test.jpg
```

程序会先打印一个输入和九个输出的shape、dtype、量化参数，然后提交一次NPU推理，最后打印每个FP32输出缓冲区的字节数与第一个数值。看到九个输出返回，说明自写C++程序已经跑通`rknn_init → rknn_query → rknn_inputs_set → rknn_run → rknn_outputs_get`主线。

要继续得到检测框，可以新增独立的`postprocess.hpp`和`postprocess.cc`：输入为九个`rknn_output`、九个`rknn_tensor_attr`、letterbox缩放与填充信息，输出为`Detection`列表。自有模型类别数也由这个模块读取或配置，RKNN Runtime调用代码无需随类别数改变。
