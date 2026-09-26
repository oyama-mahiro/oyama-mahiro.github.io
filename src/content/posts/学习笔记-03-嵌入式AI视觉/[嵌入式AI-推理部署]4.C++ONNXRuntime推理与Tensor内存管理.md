---
title: '[嵌入式AI-推理部署] C++ONNXRuntime推理与Tensor内存管理'
published: 2026-09-24T08:31:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍C++ONNXRuntime推理与Tensor内存管理的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', '模型部署', 'ONNX', 'RKNN']
category: '嵌入式AI-推理部署'
draft: false
lang: zh_CN
---

# 阶段4-4 C++ ONNX Runtime推理与Tensor内存管理

ONNX Runtime是用于执行ONNX模型的跨平台推理运行时。本节使用C++17完成一条通用调用链：程序启动时加载模型并读取接口；进入推理循环后创建输入Tensor、调用模型并读取输出Tensor；最终Demo再把瑞芯微优化YOLO11的九个输出交给C++后处理，得到检测框、类别编号和置信度。

## 1 Windows与Linux安装ONNX Runtime C++库

### 1.1 Windows下载并配置ONNX Runtime预编译包

C++项目需要ONNX Runtime的头文件、链接库和运行时动态库。最直接的安装方式是从[ONNX Runtime官方发布页](https://github.com/microsoft/onnxruntime/releases)下载对应版本的CPU预编译包，例如：

```text
onnxruntime-win-x64-<版本号>.zip
```

解压后的关键文件为：

```text
onnxruntime-win-x64-<版本号>/
├── include/
│   ├── onnxruntime_c_api.h
│   └── onnxruntime_cxx_api.h
└── lib/
    ├── onnxruntime.lib
    └── onnxruntime.dll
```

- `onnxruntime_cxx_api.h`提供C++接口声明。
- `onnxruntime.lib`供Visual Studio链接器使用。
- `onnxruntime.dll`在程序运行时提供接口实现。

运行Demo时，把`onnxruntime.dll`放到可执行文件所在目录即可。这样不会修改系统`PATH`，也能避免其他程序加载到不同版本的DLL。

### 1.2 Linux下载并配置ONNX Runtime

Ubuntu和Debian的官方软件源通常没有可直接使用的ONNX Runtime C++开发包，因此不能依赖下面这条命令完成安装：

```bash
sudo apt install libonnxruntime-dev
```

普通x86-64 Linux开发机可以直接下载官方`.tgz`预编译包。整个过程不经过`apt`，也不需要把文件写入`/usr/include`或`/usr/lib`：

```bash
ORT_VERSION=1.26.0

mkdir -p third_party
cd third_party

curl -LO \
  "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VERSION}/onnxruntime-linux-x64-${ORT_VERSION}.tgz"

tar -xzf "onnxruntime-linux-x64-${ORT_VERSION}.tgz"
mv "onnxruntime-linux-x64-${ORT_VERSION}" onnxruntime

cd ..
export ONNXRUNTIME_ROOT="$PWD/third_party/onnxruntime"
```

解压后主要使用以下文件：

```text
third_party/onnxruntime/
├── include/
│   ├── onnxruntime_c_api.h
│   └── onnxruntime_cxx_api.h
└── lib/
    └── libonnxruntime.so
```

程序启动时，Linux动态加载器还需要找到`libonnxruntime.so`：

```bash
export LD_LIBRARY_PATH="$ONNXRUNTIME_ROOT/lib:$LD_LIBRARY_PATH"
```

官方没有提供目标架构预编译包时，可以按照[ONNX Runtime Linux源码构建说明](https://onnxruntime.ai/docs/build/inferencing.html)生成共享库：

```bash
git clone --recursive https://github.com/microsoft/onnxruntime.git
cd onnxruntime

./build.sh \
  --config Release \
  --build_shared_lib \
  --parallel \
  --compile_no_warning_as_error
```

源码构建得到的库位于`build/Linux/Release/libonnxruntime.so`。ARM开发板需要与目标处理器架构、系统和工具链匹配的库，不能使用x86-64预编译包。

### 1.3 CMake查找和链接ONNX Runtime与OpenCV

后面的YOLO11 Demo使用以下`CMakeLists.txt`。配置项目时，通过`ONNXRUNTIME_ROOT`指定ONNX Runtime预编译包根目录；`find_package(OpenCV ...)`查找已经安装的OpenCV头文件和库：

```cmake
cmake_minimum_required(VERSION 3.16)
project(yolo11_onnx_cpp_demo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(ONNXRUNTIME_ROOT "" CACHE PATH "ONNX Runtime根目录")

# 最后的YOLO11 Demo使用OpenCV读取、预处理并保存图像。
find_package(OpenCV REQUIRED COMPONENTS core imgproc imgcodecs)

find_path(
    ONNXRUNTIME_INCLUDE_DIR
    NAMES onnxruntime_cxx_api.h
    PATHS
        "${ONNXRUNTIME_ROOT}/include"
        "${ONNXRUNTIME_ROOT}/include/onnxruntime/core/session"
    NO_DEFAULT_PATH
)

find_library(
    ONNXRUNTIME_LIBRARY
    NAMES onnxruntime
    PATHS
        "${ONNXRUNTIME_ROOT}/lib"
        "${ONNXRUNTIME_ROOT}/build/Linux/Release"
    NO_DEFAULT_PATH
)

if(NOT ONNXRUNTIME_INCLUDE_DIR OR NOT ONNXRUNTIME_LIBRARY)
    message(FATAL_ERROR "没有在ONNXRUNTIME_ROOT下找到ONNX Runtime")
endif()

add_executable(
    yolo11_onnx_demo
    main.cpp
    yolo11_postprocess.cpp
)

target_include_directories(
    yolo11_onnx_demo
    PRIVATE
        "${ONNXRUNTIME_INCLUDE_DIR}"
        ${OpenCV_INCLUDE_DIRS}
)

target_link_libraries(
    yolo11_onnx_demo
    PRIVATE
        "${ONNXRUNTIME_LIBRARY}"
        ${OpenCV_LIBS}
)

# Windows把DLL复制到exe旁边，程序启动时可以直接找到它。
if(WIN32)
    add_custom_command(
        TARGET yolo11_onnx_demo
        POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${ONNXRUNTIME_ROOT}/lib/onnxruntime.dll"
                "$<TARGET_FILE_DIR:yolo11_onnx_demo>"
    )
endif()
```

## 2 C++使用ONNX Runtime执行推理的最小流程

### 2.1 程序初始化与推理循环的执行顺序

ONNX Runtime对象可以按使用频率分成两个阶段。

程序启动时只执行一次初始化：

```text
创建Ort::Env
→ 创建并配置Ort::SessionOptions
→ 创建Ort::Session并加载ONNX模型
→ 读取输入输出名称、类型和形状
```

每得到一份新输入数据，就执行一次推理循环：

```text
准备连续输入缓冲区
→ 创建输入Ort::Value
→ 调用Ort::Session::Run()
→ 读取输出Ort::Value
→ 处理本次结果
```

`Ort::Session`已经保存加载后的模型和执行计划，所以无需在每轮推理中重新创建。输入缓冲区、输入Tensor和输出Tensor描述的是本次数据，每一轮都可以更新或重新创建。

### 2.2 最小核心API调用代码

下面只展示创建和调用关系。代码假设模型为单输入、单输出，输入名称、输出名称、形状和数据类型都已经确定，因此不加入检查分支和异常处理。

```cpp
#include <onnxruntime_cxx_api.h>

#include <cstdint>
#include <vector>

int main() {
    // ---------- 程序初始化：只执行一次 ----------
    // environment是Ort::Env类创建出的对象，负责保存运行环境和日志配置。
    // 后面的session依赖它，所以environment要比session活得更久。
    Ort::Env environment(
        ORT_LOGGING_LEVEL_WARNING,
        "minimal_onnx_demo"
    );

    // session_options先收集模型会话的配置。
    // 这里启用扩展计算图优化，创建session时会读取这份配置。
    Ort::SessionOptions session_options;
    session_options.SetGraphOptimizationLevel(
        GraphOptimizationLevel::ORT_ENABLE_EXTENDED
    );

    // session代表已经加载好的model.onnx。
    // 这一句会读取模型并建立会话，但还没有送入数据执行推理。
    Ort::Session session(
        environment,
        ORT_TSTR("model.onnx"),
        session_options
    );

    // 模型输入输出在ONNX图中都有名称，Run()靠名称把Tensor送到对应节点。
    // GetInputNameAllocated(0, ...)读取第0个输入名称；输出名称同理。
    Ort::AllocatorWithDefaultOptions allocator;
    Ort::AllocatedStringPtr input_name_owner =
        session.GetInputNameAllocated(0, allocator);
    Ort::AllocatedStringPtr output_name_owner =
        session.GetOutputNameAllocated(0, allocator);

    // get()取得名称字符串地址。两个owner仍然负责释放字符串内存，
    // 所以input_name和output_name使用期间不能先销毁owner。
    const char* input_name = input_name_owner.get();
    const char* output_name = output_name_owner.get();

    // ---------- 一次推理：每份新输入执行一次 ----------
    // input_shape描述本次输入Tensor的四个维度。
    // 此处[N,C,H,W]=[1,3,640,640]来自model.onnx的输入约定，
    // CreateTensor()本身不会判断四个位置分别代表批次、通道、高度和宽度。
    // input_data真正拥有1×3×640×640个float元素，并且元素排列也必须符合NCHW。
    // 实际程序要在CreateTensor()前把本次输入数据写入input_data。
    std::vector<std::int64_t> input_shape{1, 3, 640, 640};
    std::vector<float> input_data(1 * 3 * 640 * 640);

    // memory_info告诉ONNX Runtime：input_data位于CPU默认内存中。
    Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(
        OrtArenaAllocator,
        OrtMemTypeDefault
    );

    // input_tensor把数据地址、元素数量和形状组合成模型可以接收的Tensor。
    // 五个实参依次表示：CPU内存描述、数据首地址、float元素数、形状数组、维度数。
    // CreateTensor()引用input_data，不复制其中的1,228,800个float元素；
    // 所以Run()结束前，input_data不能销毁，也不能因扩容而更换底层地址。
    Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
        memory_info,
        input_data.data(),
        input_data.size(),
        input_shape.data(),
        input_shape.size()
    );

    // Run()把input_name与input_tensor配成一组输入，送入模型执行计算。
    // 参数依次为：本次运行设置、输入名称数组、输入Tensor数组、输入数量、
    // 输出名称数组、输出数量。这里两个数量都是1，因为示例模型是单输入、单输出。
    // output_name指定本次要取回哪个输出，返回值outputs负责持有结果Tensor。
    std::vector<Ort::Value> outputs = session.Run(
        Ort::RunOptions{nullptr},
        &input_name,
        &input_tensor,
        1,
        &output_name,
        1
    );

    // 第0个Ort::Value对应上面请求的output_name。
    // output_data直接指向该输出Tensor内部的float数据，没有发生整段复制；
    // outputs[0]销毁后，这个地址也随之失效。
    const float* output_data = outputs[0].GetTensorData<float>();
    return 0;
}
```

这段代码中的核心位置只有三处：`Ort::Session`加载模型，`Ort::Value::CreateTensor()`把C++缓冲区描述成模型输入，`session.Run()`执行一次模型计算。第3部分按照完全相同的顺序解释每个对象和参数。

## 3 ONNX Runtime C++推理API的参数与作用

### 3.1 初始化阶段：`Ort::Env`、`Ort::SessionOptions`与`Ort::Session`

先区分类和对象。`Ort::Env`、`Ort::SessionOptions`、`Ort::Session`是ONNX Runtime定义的C++类，也就是三种对象类型；`environment`、`session_options`、`session`是程序根据这些类创建出来的具体对象。类规定对象能保存什么数据、能调用什么函数，对象保存当前程序这一次实际使用的状态。

**为什么需要`Ort::Env`**

ONNX Runtime可能同时为多个模型会话提供服务，因此把进程级运行环境和某一个具体模型分开管理。`Ort::Env`对象负责初始化运行时环境并保存日志配置，它不保存某个ONNX模型，也不执行某一轮推理。

```cpp
// Ort::Env是类，environment是根据该类创建的对象。
// 第1个参数规定最低日志等级：WARNING会输出警告和错误。
// 第2个参数是日志标识，运行时日志会用它标明来源。
Ort::Env environment(
    ORT_LOGGING_LEVEL_WARNING,
    "yolo11_demo"
);
```

这行代码调用`Ort::Env`的构造函数。C++构造函数没有普通函数那样的返回值；构造成功后，结果就是已经存在的`environment`对象，构造失败则抛出`Ort::Exception`。后续创建`Session`时会把`environment`传进去，所以只要`Session`仍然存在，`environment`也要保持有效。

**为什么需要`Ort::SessionOptions`**

创建模型会话前，程序可能要指定线程数、计算图优化等级或执行提供程序。ONNX Runtime用独立的`Ort::SessionOptions`对象先收集这些配置，再在创建`Session`时一次性读取。这样，同一个`Env`可以使用不同配置创建多个模型会话。

```cpp
// 默认构造函数创建一份可继续修改的会话配置对象。
Ort::SessionOptions session_options;

// 参数1表示单个算子内部最多使用1个执行线程。
session_options.SetIntraOpNumThreads(1);

// 参数ORT_ENABLE_EXTENDED表示启用扩展计算图优化。
session_options.SetGraphOptimizationLevel(
    GraphOptimizationLevel::ORT_ENABLE_EXTENDED
);
```

`SetIntraOpNumThreads(int thread_count)`和`SetGraphOptimizationLevel(GraphOptimizationLevel level)`都会修改`session_options`对象自身，并返回该配置对象的引用，因此接口也支持连续调用。本文没有使用返回值。线程数应结合推理延迟和整个程序的CPU占用测试；`ORT_ENABLE_EXTENDED`适合普通CPU推理。`Session`创建完成后，它已经复制或使用了所需配置，随后修改原来的`session_options`不会改变已有会话。

**为什么需要`Ort::Session`**

加载和准备一个模型需要解析ONNX文件、检查计算图并建立执行计划。如果每一轮输入都重新完成这些工作，推理循环会产生大量重复开销。`Ort::Session`对象代表一个已经加载并准备好的模型，程序启动时创建一次，后续每轮都在同一个对象上调用`Run()`。

```cpp
// environment来自本节前面创建的Ort::Env对象。
// ORT_TSTR("yolo11n.onnx")给出模型文件路径，并适配Windows和Linux路径字符类型。
// session_options来自前面已经设置好的会话配置对象。
Ort::Session session(
    environment,
    ORT_TSTR("yolo11n.onnx"),
    session_options
);
```

`Ort::Session`同样通过构造函数创建对象，没有单独的返回值。构造成功后，`session`保存当前模型会话；构造失败会抛出`Ort::Exception`，例如模型路径错误或模型计算图无法被当前运行时加载。此时还没有输入Tensor，也没有执行模型计算。下一步要通过这个`session`读取当前模型实际声明的输入输出接口。

### 3.2 初始化阶段：读取模型输入输出接口

`Session`已经加载模型，但C++程序还不知道怎样调用这个模型。一个输入接口至少包含四项信息：它是第几个输入、在ONNX图中叫什么、接收哪种元素类型、接收什么形状。这四项信息都来自`session`，其中“名称”和“类型形状信息”是两条独立的查询结果。

名称用于`Run()`建立连接。例如模型输入节点名为`images`，调用时必须告诉`Run()`：“这次的输入Tensor要送到`images`。”类型和形状用于创建输入Tensor。例如`float32[1,3,640,640]`表示程序要提供1,228,800个连续`float`元素。后文的`input_tensor_info`只保存类型和形状等Tensor元数据；`input_name`需要通过名称查询接口单独取得。

**先取得输入输出数量**

一个模型可能有多个输入和多个输出，所以读取具体接口前要先取得数量：

```cpp
// GetInputCount()查询session中模型声明的输入个数。
// 返回值类型size_t用于保存非负的数量和索引范围。
const std::size_t input_count = session.GetInputCount();

// GetOutputCount()按照相同方式返回模型输出个数。
const std::size_t output_count = session.GetOutputCount();
```

单输入模型的有效输入索引只有`0`；九输出模型的有效输出索引为`0`到`8`。这两个函数只返回数量，不返回名称、类型或形状。

**再从模型中取得输入输出名称**

名称字符串保存在ONNX模型内部。`Session`读取模型后可以按索引复制这些名称：

```cpp
// 这个分配器供ONNX Runtime申请“名称副本”所需的字符串内存。
Ort::AllocatorWithDefaultOptions allocator;

// 参数0表示读取第0个输入。
// 返回的AllocatedStringPtr拥有复制出来的输入名称，例如"images"。
Ort::AllocatedStringPtr input_name_owner =
    session.GetInputNameAllocated(0, allocator);

// get()返回字符串首地址，Run()后面需要const char*形式的名称。
// input_name本身不拥有内存，内存仍由input_name_owner管理。
const char* input_name = input_name_owner.get();

// 第0个输出名称采用完全相同的获取方式。
Ort::AllocatedStringPtr output_name_owner =
    session.GetOutputNameAllocated(0, allocator);
const char* output_name = output_name_owner.get();
```

`GetInputNameAllocated(index, allocator)`中的`index`决定读取哪个输入，`allocator`负责为返回的名称副本分配内存。返回类型`Ort::AllocatedStringPtr`是带自动释放功能的智能指针对象。它离开作用域时会通过对应分配器释放名称内存。`input_name`只是指向这段字符串的地址，所以`Run()`使用它时，`input_name_owner`必须仍然存在。

多输出模型需要保存每一个名称所有者，再建立裸指针数组：

```cpp
std::vector<Ort::AllocatedStringPtr> output_name_owners;
std::vector<const char*> output_names;

output_name_owners.reserve(output_count);
output_names.reserve(output_count);

for (std::size_t index = 0; index < output_count; ++index) {
    // 每轮返回一个拥有名称内存的AllocatedStringPtr对象。
    output_name_owners.push_back(
        session.GetOutputNameAllocated(index, allocator)
    );

    // Run()需要const char*数组，所以把当前名称地址放入output_names。
    // 真正的字符串内存继续由output_name_owners[index]持有。
    output_names.push_back(output_name_owners.back().get());
}
```

**最后取得输入的类型和形状**

名称解决“这个Tensor送到模型的哪个入口”，类型和形状解决“这个Tensor应当怎样创建”。ONNX的输入值还可能是序列或映射，所以`GetInputTypeInfo()`先返回通用类型信息对象；确认当前输入是普通Tensor后，再取得Tensor专用信息。

```cpp
// 参数0仍然表示第0个输入。
// 返回的Ort::TypeInfo描述这个输入属于哪一类ONNX值。
Ort::TypeInfo input_type_info = session.GetInputTypeInfo(0);

// 当前模型输入是普通Tensor，因此进一步取得Tensor元素类型和形状。
// 返回的input_tensor_info是元数据对象，不包含本次实际输入数据。
Ort::TensorTypeAndShapeInfo input_tensor_info =
    input_type_info.GetTensorTypeAndShapeInfo();

// GetElementType()返回ONNX元素类型枚举。
// FLOAT表示后面应使用float缓冲区和CreateTensor<float>()。
ONNXTensorElementDataType input_element_type =
    input_tensor_info.GetElementType();

// GetShape()返回模型声明的各维长度，例如[1,3,640,640]。
std::vector<std::int64_t> declared_input_shape =
    input_tensor_info.GetShape();
```

`Ort::TypeInfo`和`Ort::TensorTypeAndShapeInfo`都是保存元数据的C++对象。它们描述模型接口，不持有本次推理的输入元素。`GetElementType()`返回`ONNXTensorElementDataType`枚举；`GetShape()`返回`std::vector<int64_t>`，每个元素对应一维长度。

固定形状会返回正整数，例如`[1,3,640,640]`。动态维度通常返回负数，例如`[-1,3,-1,-1]`。模型声明允许动态长度时，程序要根据本次实际数据得到`actual_input_shape`，把动态位置换成正整数。下一节使用这个实际形状分配缓冲区并创建输入Tensor。输出名称、类型和声明形状可以通过`GetOutputNameAllocated()`与`GetOutputTypeInfo()`按相同思路读取。官方[`Ort::Session`接口](https://onnxruntime.ai/docs/api/c/struct_ort_1_1_session.html)给出了这些函数的当前声明。

### 3.3 推理循环：输入缓冲区、`Ort::MemoryInfo`与输入`Ort::Value`

模型接口信息已经说明需要什么数据，本节开始准备某一轮真正要送入模型的元素。ONNX Runtime把“存放元素的缓冲区”和“描述这段元素的Tensor对象”分开：`std::vector<float>`拥有实际数据，`Ort::Value`记录数据地址、类型和形状。

**为什么先准备连续输入缓冲区**

Tensor中的元素要按照确定顺序连续存放，运行时才能根据形状计算每个元素的地址。假设第3.2节读取到的模型输入为`float32[1,3,640,640]`，元素数量为：

$$
1\times3\times640\times640=1\,228\,800
$$

```cpp
// actual_input_shape描述本轮真正使用的形状。
// 固定形状可以直接采用模型声明；动态形状要先替换成实际正整数。
std::vector<std::int64_t> actual_input_shape{1, 3, 640, 640};

// input_data拥有1,228,800个连续float元素。
// 前处理或其他上游代码要在创建Tensor前把本轮数据写入这里。
std::vector<float> input_data(1 * 3 * 640 * 640);
```

`input_data.data()`返回第一个元素的地址，`input_data.size()`返回元素数量。两者仍由`input_data`对象负责管理；从`vector`取得地址不会转移内存所有权。

**为什么还需要`Ort::MemoryInfo`**

一个原始地址本身不能说明它位于CPU内存、CUDA设备内存还是其他设备内存。ONNX Runtime支持多种执行设备，因此使用`Ort::MemoryInfo`对象描述地址所在设备和内存类型。本例的`std::vector`位于CPU可访问内存：

```cpp
// CreateCpu()创建并返回一个Ort::MemoryInfo对象。
// OrtArenaAllocator和OrtMemTypeDefault共同描述普通CPU Tensor内存。
Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(
    OrtArenaAllocator,
    OrtMemTypeDefault
);
```

`CreateCpu(allocator_type, memory_type)`是静态函数。第一个参数`OrtArenaAllocator`是CPU分配器类型标记，第二个参数`OrtMemTypeDefault`是CPU默认内存类型。返回的`memory_info`只描述内存属性，不拥有也不分配`input_data`。

**为什么要用`Ort::Value::CreateTensor()`**

`float*`只表示一段32位浮点数内存，模型还需要知道这段内存共有多少个元素，以及这些元素组成什么形状。`Ort::Value`是ONNX Runtime用来表示运行时值的C++对象；普通Tensor、序列等ONNX值都通过它在接口间传递。`CreateTensor<float>()`把本轮缓冲区包装成一个Tensor形式的`Ort::Value`：

```cpp
// 模板参数float说明每个输入元素是C++ float，对应ONNX float32。
// 第1个实参说明数据位于CPU内存。
// 第2、3个实参给出数据首地址和元素数量。
// 第4、5个实参给出形状数组首地址和维数。
Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
    memory_info,
    input_data.data(),
    input_data.size(),
    actual_input_shape.data(),
    actual_input_shape.size()
);
```

`CreateTensor<float>()`返回一个`Ort::Value`对象，代码把它命名为`input_tensor`。这个对象保存Tensor描述，并引用`input_data`的地址。它不会复制1,228,800个元素，也不会接管`input_data`的释放责任。

因此这里存在明确的所有权关系：`input_data`拥有实际元素，`input_tensor`引用这些元素，下一节的`Run()`通过`input_tensor`读取它们。从创建`input_tensor`到`Run()`返回期间，`input_data`必须保持有效，也不能执行可能改变底层地址的`resize()`或`push_back()`。模板参数`float`必须与第3.2节读取到的`input_element_type`一致。官方[`Ort::Value::CreateTensor()`接口](https://onnxruntime.ai/docs/api/c/struct_ort_1_1_value.html)明确区分了元素数量模板重载和字节数量重载。

### 3.4 推理循环：`Ort::Session::Run()`执行模型

`Session`已经保存模型，`input_tensor`已经描述本轮输入。此时还差一步：告诉模型“这个Tensor对应哪个输入节点，以及本次想取回哪些输出节点”。`Run()`同时接收名称和Tensor，是因为ONNX模型可能有多个输入，运行时必须按名称把每个值送到正确入口。

单输入单输出模型可以直接使用第3.2节取得的`input_name`和`output_name`，以及第3.3节创建的`input_tensor`：

```cpp
// Ort::RunOptions{nullptr}表示本轮没有额外的终止标记、日志标签等设置。
// &input_name是输入名称数组的首地址；数组中只有一个名称。
// &input_tensor是输入Ort::Value数组的首地址；它与input_name处于相同索引0。
// 第一个1说明本轮提供一组“输入名称+输入Tensor”。
// &output_name指定需要取回的一个模型输出。
// 第二个1说明本轮请求一个输出。
std::vector<Ort::Value> outputs = session.Run(
    Ort::RunOptions{nullptr},
    &input_name,
    &input_tensor,
    1,
    &output_name,
    1
);
```

这里调用的是返回输出向量的`Run()`重载。函数开始后，ONNX Runtime根据`input_name`找到模型输入节点，通过`input_tensor`读取`input_data`，执行计算图，再为请求的`output_name`建立输出Tensor。

返回类型`std::vector<Ort::Value>`表示“由多个运行时值组成的C++动态数组”。代码把返回对象命名为`outputs`。单输出时`outputs.size()`为1，`outputs[0]`对应`output_name`；多输出时，返回顺序严格跟随传给`Run()`的`output_names`顺序。

多输入模型使用两个等长数组建立位置对应关系：

```cpp
// input_names[0]对应input_tensors[0]，input_names[1]对应input_tensors[1]。
std::vector<const char*> input_names{/* 从Session读取的输入名称 */};
std::vector<Ort::Value> input_tensors{/* 为本轮创建的输入Tensor */};

// output_names决定希望取回哪些输出，也决定outputs的返回顺序。
std::vector<const char*> output_names{/* 从Session读取的输出名称 */};

std::vector<Ort::Value> outputs = session.Run(
    Ort::RunOptions{nullptr},
    input_names.data(),
    input_tensors.data(),
    input_tensors.size(),
    output_names.data(),
    output_names.size()
);
```

`data()`返回向量底层数组首地址，`size()`返回数组元素个数。名称数组中的字符串仍由第3.2节的`Ort::AllocatedStringPtr`对象持有，输入Tensor仍引用第3.3节的输入缓冲区。同步`Run()`返回时，本轮模型计算已经完成，`outputs`开始持有本轮输出结果。

### 3.5 推理循环：读取输出Tensor及其内存有效期

`Run()`只返回`Ort::Value`对象，不会自动把输出转换成某个业务结构。程序需要先读取本次输出的真实类型和形状，再取得元素地址。这样，同一套接口可以处理固定输出、动态输出以及不同元素类型的模型。

下面读取第一个输出。`output`使用引用指向`outputs[0]`，没有复制整个输出Tensor：

```cpp
// at(0)取得第0个输出Ort::Value；const引用禁止通过output改写对象。
const Ort::Value& output = outputs.at(0);

// GetTensorTypeAndShapeInfo()返回本次输出的Tensor元数据对象。
// 动态模型经过Run()后，这里的形状已经是本次实际结果形状。
Ort::TensorTypeAndShapeInfo output_tensor_info =
    output.GetTensorTypeAndShapeInfo();

// 返回ONNX元素类型枚举，用来决定后面GetTensorData<T>()中的T。
ONNXTensorElementDataType output_type =
    output_tensor_info.GetElementType();

// 返回各维长度，例如[1,84,8400]。
std::vector<std::int64_t> output_shape =
    output_tensor_info.GetShape();

// 返回所有维长度的乘积，也就是可以读取的元素总数。
std::size_t output_element_count =
    output_tensor_info.GetElementCount();

// 当前output_type确认是ONNX float32后，使用float读取内部数据。
// 返回的是只读地址，没有复制output_element_count个元素。
const float* output_data = output.GetTensorData<float>();
```

`output_tensor_info`只保存类型、形状和元素数量等元数据；实际元素仍由`output`对应的`Ort::Value`持有。`GetTensorData<float>()`返回`const float*`，调用者可以在`0`到`output_element_count-1`范围内读取结果。

`GetTensorData<T>()`不会检查模板类型，所以`T`必须由前面的`output_type`决定。若`output_type`是`ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT`，对应的C++类型是`float`；若输出为`INT64`，应使用`std::int64_t`。用错误类型解释同一串字节会得到无意义结果。

`output_data`的内存由`output`管理，`output`又是`outputs`向量中的一个元素。只要对应`Ort::Value`仍然存在，地址就可以读取；`outputs`被销毁、清空或覆盖后，该地址失效。后处理若在当前作用域立即完成，可以直接读取该地址。结果需要跨越`outputs`生命周期时，应在地址有效期间复制到自己的容器：

```cpp
// saved_output拥有复制后的元素，后续不再依赖outputs[0]的生命周期。
std::vector<float> saved_output(
    output_data,
    output_data + output_element_count
);
```

## 4 C++调用ONNX模型的常见问题与解决方法

### 4.1 输入输出名称或数量不匹配

`Run()`可能报告无效输入名称、缺少必需输入或输出名称不存在。原因通常是程序硬编码了旧模型接口，或者名称数组、Tensor数组和数量参数没有一一对应。应从当前`Session`读取名称和数量，并让第$i$个名称明确对应第$i$个Tensor。

### 4.2 输入Tensor和输出读取的数据类型错误

模型要求`float32`时，传入`int64` Tensor会使`Run()`直接失败。输出侧使用错误的`GetTensorData<T>()`可能不会立即报错，因为该函数不负责类型检查。输入创建前和输出读取前都要先检查`GetElementType()`返回值。

### 4.3 输入形状、动态维度或元素数量错误

模型形状、传给`CreateTensor()`的实际形状和缓冲区元素数量必须描述同一批数据。动态维度中的负数需要替换为本次输入的实际长度，再计算各维乘积。若三者不一致，程序会在创建Tensor或执行`Run()`时失败；原始缓冲区过小时还存在越界访问风险。

### 4.4 推理成功但输入数据含义错误

ONNX Runtime能够检查数据类型和形状，无法判断每一维的业务含义。相同的`[1,3,H,W]`形状仍可能存在通道顺序、数值范围或标准化方式错误。此时`Run()`正常返回，结果却没有实际意义。解决时应对照模型导出代码确认维度含义、排列方式和数值变换。

## 5 瑞芯微优化YOLO11的C++ ONNX Runtime完整推理Demo

### 5.1 Demo文件与输入输出

本Demo使用瑞芯微`rknn_model_zoo`配套导出的九输出YOLO11 ONNX。瑞芯微仓库的[YOLO11模型说明](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/README.md)给出了三组九输出结构；阶段4-3第5节已经解释其原理，本节直接使用这些输出。

目录结构如下：

```text
yolo11_onnx_cpp_demo/
├── CMakeLists.txt
├── main.cpp
├── yolo11_postprocess.h
├── yolo11_postprocess.cpp
├── yolo11n.onnx
└── test.jpg
```

这个Demo使用OpenCV计算机视觉库完成模型专用的图像输入处理。Linux可以安装开发包：

```bash
sudo apt update
sudo apt install libopencv-dev
```

Windows可以使用OpenCV官方预编译包或自行编译的安装目录；若CMake无法自动找到它，配置时通过`-DOpenCV_DIR=<包含OpenCVConfig.cmake的目录>`指定位置。OpenCV官方C++工程同样使用`find_package(OpenCV REQUIRED)`查找并通过`${OpenCV_LIBS}`链接库。[OpenCV官方CMake使用说明](https://docs.opencv.org/5.0/tutorials/introduction/using_prebuilt_binaries/using_prebuilt_binaries.html)

程序从`test.jpg`开始执行完整流程：

```text
OpenCV读取BGR图像
→ 按模型宽高等比例缩放并用0填充边缘
→ BGR转RGB
→ uint8转float32并除以255
→ HWC排列转换成连续NCHW缓冲区
→ CreateTensor()创建ONNX输入
→ Session::Run()执行YOLO11
→ 九输出后处理
→ 将检测框从模型输入坐标还原到原图
→ 绘制检测框并保存result.jpg
```

OpenCV只负责模型前后的图像操作；加载ONNX、创建Tensor和执行计算图的部分仍由ONNX Runtime完成。

这里的预处理顺序与`rknn_model_zoo`当前[YOLO11 Python参考实现](https://github.com/airockchip/rknn_model_zoo/blob/main/examples/yolo11/python/yolo11.py)保持一致：黑色补边、BGR转RGB；使用ONNX模型时再转成NCHW `float32`并除以`255`。补边颜色属于模型配套的预处理约定，不能直接套用其他YOLO示例常见的`114`。

### 5.2 C++后处理的输入、输出与执行顺序

后处理只接收九个`float32` NCHW输出及模型输入高宽。三个检测分支的起始索引为`0`、`3`和`6`：

```text
边框分布Tensor + 类别置信度Tensor + score_sum Tensor
```

本Demo与阶段4-3的Python流程保持一致，使用每组前两个输出。三个`score_sum`输出不参与计算。完整后处理顺序为：

```text
每个网格位置寻找最高类别置信度
→ 低于阈值的位置直接删除
→ 对保留位置执行稳定Softmax和DFL距离解码
→ 转换成模型输入坐标系中的xyxy边框
→ 合并三个检测尺度
→ 按类别执行NMS
→ 返回Detection列表
```

`FloatTensorView`只保存输出数据地址和形状，不接管ONNX Runtime的输出内存。`Detection`保存一个最终结果：边框左上角、右下角、置信度和类别编号。

### 5.3 C++后处理头文件

将下面代码保存为`yolo11_postprocess.h`：

```cpp
#pragma once

#include <cstdint>
#include <vector>

// FloatTensorView描述一个“只读取、不拥有”的float32 Tensor视图。
// 它的作用是把ONNX Runtime输出的数据地址和形状交给后处理，避免复制整块输出。
// data：指向连续的float32数据，内存仍由对应的Ort::Value持有。
// shape：按模型约定记录[N,C,H,W]，依次表示批次数、通道数、高度和宽度。
// 该结构不会释放data。只要后处理还在读取data，原来的Ort::Value就必须继续存在。
struct FloatTensorView {
    const float* data;
    std::vector<std::int64_t> shape;
};

// Detection保存模型输入坐标系中的一个最终检测结果。
// x1、y1：边框左上角坐标，单位为模型输入像素。
// x2、y2：边框右下角坐标，单位为模型输入像素。
// score：该结果所属类别的置信度。
// class_id：类别编号，例如COCO数据集中0表示person。
struct Detection {
    float x1;
    float y1;
    float x2;
    float y2;
    float score;
    int class_id;
};

// 处理瑞芯微优化YOLO11的九个float32 NCHW输出。
// outputs：按Session::Run()请求顺序排列的九个输出。
// input_height、input_width：模型输入Tensor的高和宽，单位为像素。
// confidence_threshold：保留候选框所需的最低类别置信度。
// iou_threshold：同类别NMS删除重叠框时使用的IoU阈值。
// 返回值：经过DFL解码、置信度筛选和NMS后的检测列表。
std::vector<Detection> post_process_yolo11(
    const std::vector<FloatTensorView>& outputs,
    int input_height,
    int input_width,
    float confidence_threshold,
    float iou_threshold
);
```

### 5.4 DFL解码、候选框筛选与NMS代码

将下面代码保存为`yolo11_postprocess.cpp`：

```cpp
#include "yolo11_postprocess.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

// 检查后处理实际使用的输出是否满足本Demo的内存读取约定。
// tensor是待检查的输出视图，name只用于生成容易定位的错误信息。
// 检查失败时抛出异常，后处理立即停止，避免按错误形状计算地址并越界读取。
void validate_nchw_tensor(
    const FloatTensorView& tensor,
    const std::string& name
) {
    if (tensor.data == nullptr) {
        // 没有数据地址时，shape即使正确也无法读取任何元素。
        throw std::runtime_error(name + "的数据地址为空");
    }
    if (tensor.shape.size() != 4) {
        // nchw_offset()固定按照四维[N,C,H,W]计算地址，所以拒绝其他维数。
        throw std::runtime_error(name + "必须是四维NCHW Tensor");
    }
    if (tensor.shape[0] != 1) {
        // 本Demo没有遍历batch维，只处理第0个样本，因此只接受batch=1。
        throw std::runtime_error(name + "必须满足batch=1");
    }
    for (const std::int64_t dimension : tensor.shape) {
        if (dimension <= 0) {
            throw std::runtime_error(name + "包含无效维度");
        }
    }
}

// 计算NCHW Tensor中[0, channel, y, x]元素相对data首地址的元素偏移。
// 连续NCHW内存中，x变化最快，其次是y，最后是channel，因此公式为：
// offset = (channel * height + y) * width + x。
// Demo固定batch=1，所以这里省略batch * channel_count * height * width这一项。
// 返回值的单位是“float元素个数”，用于data[offset]，不是字节数。
std::size_t nchw_offset(
    const FloatTensorView& tensor,
    int channel,
    int y,
    int x
) {
    const std::size_t height =
        static_cast<std::size_t>(tensor.shape[2]);
    const std::size_t width =
        static_cast<std::size_t>(tensor.shape[3]);

    return (
        static_cast<std::size_t>(channel) * height +
        static_cast<std::size_t>(y)
    ) * width + static_cast<std::size_t>(x);
}

// 对特征图中(y,x)这个网格位置执行DFL解码。
// box_tensor的通道依次分为左、上、右、下四组，每组包含bin_count个原始分数。
// 函数先对每组分数做Softmax，再用0、1、...、bin_count-1计算加权平均距离。
// 返回值顺序为[左,上,右,下]，单位是当前特征图的网格长度；调用者随后乘stride换成输入像素。
std::array<float, 4> decode_dfl(
    const FloatTensorView& box_tensor,
    int y,
    int x
) {
    const int channel_count = static_cast<int>(box_tensor.shape[1]);
    if (channel_count % 4 != 0) {
        // 通道无法分成左、上、右、下四组时，无法确定每组包含多少个离散位置。
        throw std::runtime_error("边框分布通道数不能平均分成四组");
    }

    const int bin_count = channel_count / 4;
    std::array<float, 4> distances{};

    for (int direction = 0; direction < 4; ++direction) {
        // direction依次取0、1、2、3，对应左、上、右、下。
        // 第一步只寻找当前方向所有bin中的最大原始分数。
        // 后面计算exp(logit - maximum)，可以避免较大logit直接指数运算发生溢出。
        float maximum = -std::numeric_limits<float>::infinity();
        for (int bin = 0; bin < bin_count; ++bin) {
            const int channel = direction * bin_count + bin;
            maximum = std::max(
                maximum,
                box_tensor.data[nchw_offset(box_tensor, channel, y, x)]
            );
        }

        // exponential_sum是Softmax分母；weighted_sum是“概率分子乘离散位置”的总和。
        // 两者相除后得到该方向的期望距离，例如结果2.4表示距离网格中心2.4个网格单位。
        float exponential_sum = 0.0F;
        float weighted_sum = 0.0F;
        for (int bin = 0; bin < bin_count; ++bin) {
            const int channel = direction * bin_count + bin;
            const float logit =
                box_tensor.data[nchw_offset(box_tensor, channel, y, x)];
            const float exponential = std::exp(logit - maximum);

            exponential_sum += exponential;
            weighted_sum += exponential * static_cast<float>(bin);
        }

        distances[direction] = weighted_sum / exponential_sum;
    }

    return distances;
}

// 计算两个xyxy边框的交并比（Intersection over Union，IoU）。
// 输入坐标均属于模型输入坐标系；返回0到1之间的重叠比例。
// NMS使用该返回值判断两个同类别框是否重复。
float intersection_over_union(
    const Detection& first,
    const Detection& second
) {
    const float intersection_x1 = std::max(first.x1, second.x1);
    const float intersection_y1 = std::max(first.y1, second.y1);
    const float intersection_x2 = std::min(first.x2, second.x2);
    const float intersection_y2 = std::min(first.y2, second.y2);

    const float intersection_width =
        std::max(0.0F, intersection_x2 - intersection_x1);
    const float intersection_height =
        std::max(0.0F, intersection_y2 - intersection_y1);
    const float intersection_area =
        intersection_width * intersection_height;

    const float first_area =
        std::max(0.0F, first.x2 - first.x1) *
        std::max(0.0F, first.y2 - first.y1);
    const float second_area =
        std::max(0.0F, second.x2 - second.x1) *
        std::max(0.0F, second.y2 - second.y1);
    const float union_area =
        first_area + second_area - intersection_area;

    return union_area > 0.0F ? intersection_area / union_area : 0.0F;
}

// 对候选框执行按类别的非极大值抑制（Non-Maximum Suppression，NMS）。
// candidates按值传入，函数可以在内部排序，不会改变调用者原来的容器。
// iou_threshold规定“多大重叠算重复”；返回值只包含最终保留的框。
std::vector<Detection> class_aware_nms(
    std::vector<Detection> candidates,
    float iou_threshold
) {
    // 先按置信度从高到低排序，让高分框优先进入kept。
    std::sort(
        candidates.begin(),
        candidates.end(),
        [](const Detection& left, const Detection& right) {
            return left.score > right.score;
        }
    );

    std::vector<Detection> kept;
    kept.reserve(candidates.size());

    for (const Detection& candidate : candidates) {
        // suppressed表示当前候选框是否已被某个更高分的同类别框压制。
        bool suppressed = false;

        for (const Detection& accepted : kept) {
            if (candidate.class_id != accepted.class_id) {
                // 不同类别之间不互相删除，例如person框不会删除与它重叠的bicycle框。
                continue;
            }

            if (
                intersection_over_union(candidate, accepted) >
                iou_threshold
            ) {
                suppressed = true;
                // 已确定当前框需要删除，无须继续与后面的保留框比较。
                break;
            }
        }

        if (!suppressed) {
            // 当前框未与任何高分同类别框产生过大重叠，加入最终结果。
            kept.push_back(candidate);
        }
    }

    return kept;
}

}  // namespace

std::vector<Detection> post_process_yolo11(
    const std::vector<FloatTensorView>& outputs,
    int input_height,
    int input_width,
    float confidence_threshold,
    float iou_threshold
) {
    // ---------- 入口检查：确保后面的固定索引和地址公式成立 ----------
    if (outputs.size() != 9) {
        throw std::runtime_error("瑞芯微优化YOLO11必须提供九个输出");
    }
    if (input_height <= 0 || input_width <= 0) {
        throw std::runtime_error("模型输入高宽必须是正整数");
    }
    if (
        confidence_threshold < 0.0F || confidence_threshold > 1.0F ||
        iou_threshold < 0.0F || iou_threshold > 1.0F
    ) {
        throw std::runtime_error("置信度阈值和IoU阈值必须位于0到1之间");
    }

    // candidates汇总三个检测分支解码出的候选框；最后统一交给NMS去重。
    std::vector<Detection> candidates;

    // 三个分支起始索引为0、3、6。
    // 每个分支读取边框分布和类别置信度，第三个score_sum输出保持未使用。
    constexpr std::array<std::size_t, 3> branch_starts{0U, 3U, 6U};
    for (const std::size_t branch_start : branch_starts) {
        const FloatTensorView& box_tensor = outputs[branch_start];
        const FloatTensorView& class_tensor = outputs[branch_start + 1];

        validate_nchw_tensor(box_tensor, "边框分布输出");
        validate_nchw_tensor(class_tensor, "类别置信度输出");

        if (
            box_tensor.shape[2] != class_tensor.shape[2] ||
            box_tensor.shape[3] != class_tensor.shape[3]
        ) {
            throw std::runtime_error("同一分支的边框和类别特征图尺寸不同");
        }

        const int grid_height = static_cast<int>(box_tensor.shape[2]);
        const int grid_width = static_cast<int>(box_tensor.shape[3]);
        const int class_count = static_cast<int>(class_tensor.shape[1]);

        // 一个网格在模型输入中覆盖的像素数由“输入尺寸÷特征图尺寸”得到。
        // 例如输入宽640、特征图宽80时，stride_x=8，即横向一个网格相隔8个输入像素。
        const float stride_x =
            static_cast<float>(input_width) /
            static_cast<float>(grid_width);
        const float stride_y =
            static_cast<float>(input_height) /
            static_cast<float>(grid_height);

        for (int y = 0; y < grid_height; ++y) {
            for (int x = 0; x < grid_width; ++x) {
                // class_tensor在同一(y,x)上为每个类别保存一个分数。
                // 这里遍历类别通道，只保留当前网格位置分数最高的类别及其编号。
                int best_class_id = 0;
                float best_score = class_tensor.data[
                    nchw_offset(class_tensor, 0, y, x)
                ];

                for (int class_id = 1; class_id < class_count; ++class_id) {
                    const float score = class_tensor.data[
                        nchw_offset(class_tensor, class_id, y, x)
                    ];

                    if (score > best_score) {
                        best_score = score;
                        best_class_id = class_id;
                    }
                }

                // 最高类别分数仍低于阈值，说明该网格没有可靠目标。
                // continue直接处理下一个网格，当前网格不会产生候选框，同时省去DFL指数运算。
                if (best_score < confidence_threshold) {
                    continue;
                }

                const std::array<float, 4> distance =
                    decode_dfl(box_tensor, y, x);

                // YOLO11以网格中心为边框距离的参考点，+0.5把整数网格索引移到单元格中心。
                const float center_x = static_cast<float>(x) + 0.5F;
                const float center_y = static_cast<float>(y) + 0.5F;

                // distance仍以网格长度为单位。乘以对应stride后，四个坐标变成模型输入像素。
                // 此处只收集候选框；三个分支全部处理完后再统一执行NMS。
                candidates.push_back(Detection{
                    (center_x - distance[0]) * stride_x,
                    (center_y - distance[1]) * stride_y,
                    (center_x + distance[2]) * stride_x,
                    (center_y + distance[3]) * stride_y,
                    best_score,
                    best_class_id
                });
            }
        }
    }

    // std::move把候选框容器交给NMS使用，避免再复制一份可能很大的候选框列表。
    return class_aware_nms(std::move(candidates), iou_threshold);
}
```

这份实现直接按NCHW地址公式读取ONNX Runtime输出，没有复制九个Tensor。`decode_dfl()`使用减最大值的稳定Softmax；`class_aware_nms()`只在相同类别之间抑制重叠框，避免一个类别删除另一个类别的结果。

### 5.5 OpenCV预处理、ONNX Runtime推理与结果绘制主程序

主程序中的`cv::Mat`是OpenCV图像矩阵对象。`cv::imread()`把`test.jpg`解码成BGR图像，`cv::resize()`完成等比例缩放，`cv::copyMakeBorder()`把缩放图放入固定大小画布，`cv::cvtColor()`将BGR转换成模型需要的RGB。代码随后手动把OpenCV的HWC交错数据重排为ONNX模型要求的NCHW连续数据。OpenCV官方文档给出了[图像读取与保存接口](https://docs.opencv.org/4.x/d4/da8/group__imgcodecs.html)以及[图像缩放接口](https://docs.opencv.org/4.x/da/d54/group__imgproc__transform.html)的参数定义。

`LetterboxInfo`保存缩放比例以及横向、纵向总补边的一半，推理完成后按照`原图坐标=(模型坐标-半边补边量)/缩放比例`还原检测框。总补边为奇数时，一侧会比另一侧多一个像素，但坐标变换仍使用精确的`0.5`。`PreparedInput`让NCHW缓冲区和这组坐标变换参数一起返回，避免预处理结束后丢失还原信息。

将下面代码保存为`main.cpp`：

```cpp
#include <onnxruntime_cxx_api.h>

#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>

#include "yolo11_postprocess.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {

// 将形状数组转换成[1,3,640,640]形式的日志文字。
// 输入是从ONNX Runtime读取的维度列表，返回值只用于打印，不改变原形状。
std::string shape_to_string(const std::vector<std::int64_t>& shape) {
    std::ostringstream stream;
    stream << '[';
    for (std::size_t index = 0; index < shape.size(); ++index) {
        if (index != 0) {
            stream << ',';
        }
        stream << shape[index];
    }
    stream << ']';
    return stream.str();
}

// 将所有维度相乘，得到一个Tensor包含的float元素总数。
// 例如[1,3,640,640]得到1*3*640*640=1,228,800个元素。
// 发现动态维度、非正维度或乘法溢出时抛出异常，避免申请错误大小的缓冲区。
std::size_t checked_element_count(const std::vector<std::int64_t>& shape) {
    std::size_t count = 1;

    for (const std::int64_t dimension : shape) {
        if (dimension <= 0) {
            // ONNX常用-1或符号维度表示动态大小。本Demo直接采用模型声明的固定高宽，
            // 没有额外参数替换动态维度，因此要求模型输入形状全部为正整数。
            throw std::runtime_error("本Demo只接受固定正整数输入形状：" + shape_to_string(shape));
        }

        const auto size = static_cast<std::size_t>(dimension);
        // 先用除法判断下一次乘法是否超过size_t上限，防止count回绕成错误的小数值。
        if (count > std::numeric_limits<std::size_t>::max() / size) {
            throw std::runtime_error("输入Tensor元素数量溢出");
        }
        count *= size;
    }

    return count;
}

// LetterboxInfo记录等比例缩放和补边产生的坐标变换。
// scale：原图坐标乘以该比例后得到缩放图坐标。
// pad_x、pad_y：横向和纵向总补边的一半，可能带有0.5小数。
// 后处理使用这三个量把模型输入坐标还原到原图坐标。
struct LetterboxInfo {
    float scale;
    float pad_x;
    float pad_y;
};

// PreparedInput同时保存ONNX输入数据和坐标还原信息。
// tensor_data拥有连续NCHW float32内存；CreateTensor()随后只引用这块内存。
struct PreparedInput {
    std::vector<float> tensor_data;
    LetterboxInfo letterbox;
};

// 将一张OpenCV BGR图像转换成YOLO11需要的NCHW float32输入。
// source_bgr：imread()返回的原始BGR图像。
// input_height、input_width：从ONNX模型输入形状读取的目标高宽。
// 返回值：连续输入缓冲区，以及后续还原检测框所需的缩放和补边参数。
PreparedInput prepare_yolo11_input(const cv::Mat& source_bgr, int input_height, int input_width) {
    if (source_bgr.empty()) {
        // 空图像没有宽高和像素，无法执行缩放；调用者应检查输入路径是否正确。
        throw std::runtime_error("输入图像为空");
    }
    if (source_bgr.type() != CV_8UC3) {
        // 本Demo按每像素3个uint8 BGR通道读取；灰度图或带Alpha图需要另行转换。
        throw std::runtime_error("本Demo要求三通道uint8 BGR图像");
    }

    // 同时受目标宽和目标高限制，取较小比例可保证缩放后的整张图都能放进模型画布。
    const float width_scale = static_cast<float>(input_width) / source_bgr.cols;
    const float height_scale = static_cast<float>(input_height) / source_bgr.rows;
    const float scale = std::min(width_scale, height_scale);

    // 四舍五入得到实际参与resize()的整数像素尺寸。
    const int resized_width = static_cast<int>(std::round(source_bgr.cols * scale));
    const int resized_height = static_cast<int>(std::round(source_bgr.rows * scale));

    cv::Mat resized_bgr;
    cv::resize(source_bgr, resized_bgr, cv::Size(resized_width, resized_height), 0.0, 0.0, cv::INTER_LINEAR);

    // 把剩余宽高分到两侧。整数不能均分时，右侧或底部多1个像素，
    // 从而保证最终画布尺寸严格等于input_width×input_height。
    const int horizontal_padding = input_width - resized_width;
    const int vertical_padding = input_height - resized_height;
    const int pad_left = horizontal_padding / 2;
    const int pad_right = horizontal_padding - pad_left;
    const int pad_top = vertical_padding / 2;
    const int pad_bottom = vertical_padding - pad_top;

    cv::Mat letterboxed_bgr;
    // rknn_model_zoo当前YOLO11参考脚本使用0补边，本Demo保持相同预处理约定。
    cv::copyMakeBorder(resized_bgr, letterboxed_bgr,
                       pad_top, pad_bottom, pad_left, pad_right,
                       cv::BORDER_CONSTANT, cv::Scalar(0, 0, 0));

    // imread()产生BGR顺序，而该YOLO11输入使用RGB顺序，因此在归一化前交换通道。
    cv::Mat letterboxed_rgb;
    cv::cvtColor(letterboxed_bgr, letterboxed_rgb, cv::COLOR_BGR2RGB);

    // uint8的0到255转换成float32的0到1；矩阵此时仍按HWC交错排列。
    cv::Mat rgb_float;
    letterboxed_rgb.convertTo(rgb_float, CV_32FC3, 1.0 / 255.0);

    const std::size_t tensor_height = static_cast<std::size_t>(input_height);
    const std::size_t tensor_width = static_cast<std::size_t>(input_width);
    const std::size_t plane_size = tensor_height * tensor_width;
    std::vector<float> nchw_data(3U * plane_size);

    // OpenCV的CV_32FC3按HWC保存：同一像素的R、G、B连续。
    // ONNX模型要求NCHW：先连续保存整个R平面，再保存G平面和B平面。
    for (int y = 0; y < input_height; ++y) {
        const cv::Vec3f* row = rgb_float.ptr<cv::Vec3f>(y);
        for (int x = 0; x < input_width; ++x) {
            const std::size_t row_index = static_cast<std::size_t>(y);
            const std::size_t column_index = static_cast<std::size_t>(x);
            const std::size_t spatial_index = row_index * tensor_width + column_index;

            nchw_data[0U * plane_size + spatial_index] = row[x][0];  // R
            nchw_data[1U * plane_size + spatial_index] = row[x][1];  // G
            nchw_data[2U * plane_size + spatial_index] = row[x][2];  // B
        }
    }

    // 坐标还原保存总补边的一半。总补边为1时保存0.5，与参考脚本的dw、dh一致。
    LetterboxInfo letterbox{scale, horizontal_padding / 2.0F, vertical_padding / 2.0F};
    return PreparedInput{std::move(nchw_data), letterbox};
}

// 将检测框从模型输入坐标系还原到原图坐标系，并限制在图像边界内。
// 模型坐标先减去补边，再除以缩放比例：source=(model-padding)/scale。
void restore_boxes_to_source(std::vector<Detection>& detections,
                             const LetterboxInfo& letterbox,
                             int source_width, int source_height) {
    const float maximum_x = static_cast<float>(source_width);
    const float maximum_y = static_cast<float>(source_height);

    for (Detection& detection : detections) {
        detection.x1 = std::clamp((detection.x1 - letterbox.pad_x) / letterbox.scale, 0.0F, maximum_x);
        detection.y1 = std::clamp((detection.y1 - letterbox.pad_y) / letterbox.scale, 0.0F, maximum_y);
        detection.x2 = std::clamp((detection.x2 - letterbox.pad_x) / letterbox.scale, 0.0F, maximum_x);
        detection.y2 = std::clamp((detection.y2 - letterbox.pad_y) / letterbox.scale, 0.0F, maximum_y);
    }
}

// 在原图上绘制边框、类别编号和置信度。
// image由调用者持有并在原地修改；detections中的坐标已经还原到原图范围。
void draw_detections(cv::Mat& image, const std::vector<Detection>& detections) {
    for (const Detection& detection : detections) {
        const cv::Point top_left(static_cast<int>(std::round(detection.x1)),
                                 static_cast<int>(std::round(detection.y1)));
        const cv::Point bottom_right(static_cast<int>(std::round(detection.x2)),
                                     static_cast<int>(std::round(detection.y2)));

        cv::rectangle(image, top_left, bottom_right, cv::Scalar(0, 255, 0), 2);

        std::ostringstream label_stream;
        label_stream << "class=" << detection.class_id << " "
                     << std::fixed << std::setprecision(2) << detection.score;

        // 文字基线放在框顶端附近；框靠近图像上边缘时，向下移动以免文字越界。
        const cv::Point text_origin(top_left.x, std::max(15, top_left.y - 5));
        cv::putText(image, label_stream.str(), text_origin,
                    cv::FONT_HERSHEY_SIMPLEX, 0.5, cv::Scalar(0, 255, 0), 1, cv::LINE_AA);
    }
}

}  // namespace

int main() {
    try {
        // 这两个阈值只影响后处理，不会改变ONNX Runtime返回的九个原始输出Tensor。
        constexpr float confidence_threshold = 0.25F;
        constexpr float iou_threshold = 0.45F;

        // ---------- 初始化阶段：整个程序只执行一次 ----------
        // Env代表一个ONNX Runtime运行环境。WARNING表示只输出警告及更严重的日志；
        // 第二个参数是日志标签，多个推理模块共存时可据此区分日志来源。
        Ort::Env environment(ORT_LOGGING_LEVEL_WARNING, "yolo11_onnx_cpp_demo");

        // SessionOptions保存创建Session时使用的执行设置。
        // 这里把单个算子内部的CPU线程数设为1，并启用扩展级计算图优化。
        Ort::SessionOptions session_options;
        session_options.SetIntraOpNumThreads(1);
        session_options.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_EXTENDED);

        // Session加载并解析yolo11n.onnx，之后每次推理都通过这个对象调用Run()。
        // environment和session_options必须先存在；ORT_TSTR让路径兼容Windows宽字符接口。
        Ort::Session session(environment, ORT_TSTR("yolo11n.onnx"), session_options);

        // 输入输出数量来自ONNX计算图接口，不能仅凭经验手写。
        // 本Demo的后处理固定对应“一个输入、九个输出”，所以初始化时先核对数量。
        const std::size_t input_count = session.GetInputCount();
        const std::size_t output_count = session.GetOutputCount();
        if (input_count != 1 || output_count != 9) {
            throw std::runtime_error("本Demo要求单输入、九输出YOLO11模型");
        }

        // 名称字符串由ONNX Runtime分配；该对象指定使用运行库的默认分配器获取名称。
        Ort::AllocatorWithDefaultOptions allocator;

        // GetInputNameAllocated(0, allocator)读取第0个输入在ONNX中的真实名称。
        // input_name_owner拥有字符串；input_name只是借用其中的字符地址。
        // 因此input_name_owner必须一直保留到最后一次使用input_name的Run()结束。
        Ort::AllocatedStringPtr input_name_owner = session.GetInputNameAllocated(0, allocator);
        const char* input_name = input_name_owner.get();

        // owners负责九个名称字符串的生命周期；output_names保存Run()需要的const char*数组。
        // 两个vector分开保存，是因为C字符串指针本身不会负责释放名称内存。
        std::vector<Ort::AllocatedStringPtr> output_name_owners;
        std::vector<const char*> output_names;
        output_name_owners.reserve(output_count);
        output_names.reserve(output_count);

        for (std::size_t index = 0; index < output_count; ++index) {
            // 按ONNX输出索引读取名称并保存所有权，再把内部地址加入请求列表。
            // 这样Run()返回顺序与output_names一致，后处理才能按固定索引读取分支。
            output_name_owners.push_back(session.GetOutputNameAllocated(index, allocator));
            output_names.push_back(output_name_owners.back().get());
        }

        // GetInputTypeInfo(0)读取第0个模型输入的类型信息，随后取得Tensor元素类型和形状。
        // 这些信息用于按模型真实接口准备输入缓冲区，属于正常初始化流程。
        Ort::TensorTypeAndShapeInfo input_tensor_info =
            session.GetInputTypeInfo(0).GetTensorTypeAndShapeInfo();
        const std::vector<std::int64_t> input_shape = input_tensor_info.GetShape();

        if (input_tensor_info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
            // 图像预处理和CreateTensor<float>()都按float32准备数据；其他类型不能直接套用本Demo。
            throw std::runtime_error("本Demo要求float32模型输入");
        }
        if (input_shape.size() != 4 || input_shape[0] != 1 || input_shape[1] != 3) {
            // 预处理固定产生一个样本的RGB三通道数据，所以要求[N,C,H,W]中的N=1、C=3。
            throw std::runtime_error("本Demo要求[1,3,H,W]形式的NCHW输入");
        }

        // 本模型的输入约定是[N,C,H,W]，所以shape[2]和shape[3]分别表示高度和宽度。
        // ONNX Runtime不会从维度数值自行猜出语义；这个顺序来自模型接口和计算图约定。
        const int input_height = static_cast<int>(input_shape[2]);
        const int input_width = static_cast<int>(input_shape[3]);
        const std::size_t input_element_count = checked_element_count(input_shape);

        std::cout << "input name=" << input_name
                  << ", shape=" << shape_to_string(input_shape) << '\n';

        // ---------- 一次推理：每张新图像从这里开始重复 ----------
        // imread()读取test.jpg并返回BGR、HWC、uint8图像；读取失败时返回空Mat。
        cv::Mat source_image = cv::imread("test.jpg", cv::IMREAD_COLOR);
        if (source_image.empty()) {
            throw std::runtime_error("无法读取test.jpg");
        }

        // 预处理根据模型输入高宽完成缩放、补边、RGB转换、归一化和HWC转NCHW。
        // prepared_input拥有Tensor内存，并同时保存检测框还原所需的scale和padding。
        PreparedInput prepared_input = prepare_yolo11_input(source_image, input_height, input_width);
        std::vector<float>& input_data = prepared_input.tensor_data;

        if (input_data.size() != input_element_count) {
            // 该分支说明模型通道数或预处理实现与模型接口不匹配，不能继续创建Tensor。
            throw std::runtime_error("预处理结果的元素数量与模型输入形状不一致");
        }

        // MemoryInfo描述输入缓冲区所在设备和内存类型。
        // CreateCpu表示input_data位于CPU内存；后两个参数选择CPU的常用分配器和默认内存类型。
        Ort::MemoryInfo memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);

        // CreateTensor<float>()不会复制input_data，也不会通过数值判断NCHW或NHWC。
        // 它只把“一段连续float内存”与input_shape绑定成一个Tensor：
        //   memory_info        数据所在设备及内存类型；
        //   input_data.data()  连续缓冲区首地址；
        //   input_data.size()  缓冲区中的float元素数量，不是字节数；
        //   input_shape.data() 维度数组首地址，例如[1,3,640,640]；
        //   input_shape.size() 维度数量，此例为4。
        // 维度含义由ONNX模型的输入约定决定。本Demo已确认模型使用[N,C,H,W]，
        // 所以input_data也必须按NCHW顺序排列。Run()返回前不能扩容或销毁input_data。
        Ort::Value input_tensor = Ort::Value::CreateTensor<float>(
            memory_info, input_data.data(), input_data.size(), input_shape.data(), input_shape.size());

        // Session::Run()真正执行一次ONNX计算图：
        //   RunOptions{nullptr}   使用本次运行的默认设置；
        //   &input_name          一个输入名称数组的首地址；
        //   &input_tensor        与名称对应的输入Tensor数组首地址；
        //   1                    本次传入一个输入；
        //   output_names.data()  请求返回的九个输出名称；
        //   output_names.size()  请求的输出数量。
        // 返回vector的顺序与output_names一致，因此后处理可以用0、3、6定位三个分支。
        std::vector<Ort::Value> outputs = session.Run(
            Ort::RunOptions{nullptr}, &input_name, &input_tensor, 1, output_names.data(), output_names.size());

        // FloatTensorView只借用outputs中的地址，不复制九个输出。
        // post_process_yolo11()返回前，outputs及其中的Ort::Value必须保持存活；
        // 如果先销毁或覆盖outputs，output_views中的data就会成为失效指针。
        std::vector<FloatTensorView> output_views;
        output_views.reserve(outputs.size());

        for (std::size_t index = 0; index < outputs.size(); ++index) {
            // 每个Ort::Value都携带本次推理的实际输出类型和形状。
            // 即使ONNX声明了动态维度，Run()结束后这里也能取得本次运行的具体维度值。
            Ort::TensorTypeAndShapeInfo output_tensor_info = outputs[index].GetTensorTypeAndShapeInfo();

            if (output_tensor_info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT) {
                // 后处理通过GetTensorData<float>()读取数据，只适用于float32输出。
                throw std::runtime_error("九输出后处理只接受float32输出");
            }

            std::vector<std::int64_t> output_shape = output_tensor_info.GetShape();

            std::cout << "output " << index
                      << " name=" << output_names[index]
                      << ", shape=" << shape_to_string(output_shape) << '\n';

            // GetTensorData<float>()返回Ort::Value内部数据的只读地址。
            // output_shape移入视图以避免复制维度数组；输出数据本身仍由Ort::Value持有。
            output_views.push_back(
                FloatTensorView{outputs[index].GetTensorData<float>(), std::move(output_shape)});
        }

        // ONNX Runtime到这里已经完成模型前向计算。
        // 后处理读取九个原始输出，完成解码、置信度筛选和NMS，返回最终检测结果。
        std::vector<Detection> detections = post_process_yolo11(
            output_views, input_height, input_width, confidence_threshold, iou_threshold);

        // 后处理刚返回的坐标仍属于模型输入画布。
        // 使用预处理保存的缩放比例和横纵半边补边量，将所有框原地还原到test.jpg坐标系。
        restore_boxes_to_source(detections, prepared_input.letterbox,
                                source_image.cols, source_image.rows);

        std::cout << "detection count=" << detections.size() << '\n';
        for (const Detection& detection : detections) {
            std::cout << "class=" << detection.class_id
                      << " score=" << detection.score
                      << " box=(" << detection.x1 << ',' << detection.y1 << ','
                      << detection.x2 << ',' << detection.y2 << ")\n";
        }

        // 在source_image上原地绘制检测结果，然后编码并写入result.jpg。
        // imwrite()返回false表示编码器或输出路径写入失败，此时不报告推理成功。
        draw_detections(source_image, detections);
        if (!cv::imwrite("result.jpg", source_image)) {
            throw std::runtime_error("result.jpg保存失败");
        }
        std::cout << "标注结果已保存到result.jpg\n";

        return 0;
    } catch (const Ort::Exception& error) {
        // ONNX Runtime自身的模型加载、接口匹配或执行错误会进入这里。
        std::cerr << "ONNX Runtime错误：" << error.what() << '\n';
        return 1;
    } catch (const std::exception& error) {
        // 文件读取、形状检查和后处理主动抛出的错误会进入这里。
        std::cerr << "程序错误：" << error.what() << '\n';
        return 1;
    }
}
```

主程序中的ONNX Runtime调用集中在三个位置：`Ort::Session`加载模型，`CreateTensor()`创建输入，`Session::Run()`执行模型。OpenCV在调用前把`test.jpg`变成连续NCHW数据，在调用后把检测框还原到原图并保存`result.jpg`。

### 5.6 编译运行与输出结果

Linux编译运行：

```bash
cmake -S . -B build \
  -DONNXRUNTIME_ROOT="$ONNXRUNTIME_ROOT"
cmake --build build -j

export LD_LIBRARY_PATH="$ONNXRUNTIME_ROOT/lib:$LD_LIBRARY_PATH"
./build/yolo11_onnx_demo
```

Windows PowerShell编译运行：

```powershell
cmake -S . -B build `
  -DONNXRUNTIME_ROOT="D:\libraries\onnxruntime-win-x64-<版本号>" `
  -DOpenCV_DIR="D:\libraries\opencv\build\x64\vc16\lib"
cmake --build build --config Release
.\build\Release\yolo11_onnx_demo.exe
```

程序会先打印输入和九个输出的名称、形状，再打印后处理结果，例如：

```text
detection count=5
class=0 score=0.898 box=(108.2,236.4,224.7,535.1)
class=5 score=0.948 box=(91.3,136.0,554.8,440.5)
标注结果已保存到result.jpg
```

实际数量和数值取决于`test.jpg`内容。终端打印的边框已经还原到原图坐标系，`result.jpg`包含相同检测框、类别编号和置信度。
