---
title: '[嵌入式AI-C++工程] CMake：生成、审查、修改和排错'
published: 2026-09-24T08:06:00+08:00
description: '围绕嵌入式 AI 视觉工程，介绍CMake：生成、审查、修改和排错的核心原理、常用方法与实践要点。'
tags: ['嵌入式AI', 'C++', '工程实践']
category: '嵌入式AI-C++工程'
draft: false
lang: zh_CN
---

# 阶段1-7 CMake：生成、审查、修改和排错

CMake是一个跨平台构建系统生成工具。它读取项目中的`CMakeLists.txt`，根据所选生成器产生Makefile、Ninja规则或Visual Studio解决方案，再由对应构建工具调用编译器和链接器。学习本节不需要从空白默写大型工程，而是要理解target之间的依赖关系，能够给已有项目增加源码、头文件、测试和第三方库，并根据错误发生的阶段排查问题。

本文使用C++17。OpenCV及`cv::Mat`已经在阶段1-3第3～6节介绍；本节只把OpenCV当作第三方C++库，重点讨论它如何被CMake发现、连接和验证，不重复图像内存语义。

## 1 CMake的target模型与依赖接入流程

### 1.1 配置、编译、链接与程序运行的阶段划分

一个C++程序从配置到运行通常经过四个阶段：

1. **配置与生成**：CMake读取`CMakeLists.txt`、检查编译器和第三方包，生成底层构建规则。
2. **编译**：编译器把每个`.cpp`编译为目标文件。此时必须能找到源代码包含的头文件。
3. **链接**：链接器把目标文件和库组合成可执行文件或新的库。此时必须能找到函数、变量等符号的定义。
4. **运行**：操作系统启动程序；如果程序依赖动态库，动态加载器还必须能在运行环境中找到这些库。

这四个阶段的错误不能混为一谈：

| 典型现象 | 失败阶段 | 首先检查 |
|---|---|---|
| `Could not find a package configuration file` | CMake配置 | 包是否安装、`CMAKE_PREFIX_PATH`或`<Package>_DIR` |
| `fatal error: xxx.hpp: No such file or directory` | 编译 | target的头文件搜索目录 |
| `undefined reference`、`unresolved external symbol` | 链接 | target是否链接实现所在的库 |
| `cannot open shared object file`、缺少DLL | 运行 | 动态库部署位置和运行时搜索路径 |

推荐使用源目录外构建，避免生成文件混入源代码：

```bash
cmake -S . -B build
cmake --build build
```

`-S .`指定当前目录为源目录，`-B build`指定`build`为构建目录。第二条命令不直接假设底层使用Make、Ninja还是Visual Studio，而是让CMake调用当前构建目录对应的构建工具。

### 1.2 target保存的源码、头文件、库和使用要求

**构建目标（target）**是CMake描述一个可构建单元的核心对象。常见target包括可执行程序、静态库、动态库、接口库和第三方包提供的导入target。

一个target可以保存：

- 哪些源文件参与编译；
- 编译这些源文件时搜索哪些头文件目录；
- 使用哪个C++标准和哪些编译选项；
- 链接哪些库；
- 哪些要求还要继续传给依赖它的下游target。

例如，`vision_core`是库，`vision_app`是程序：

```cmake
# 当前工程负责从源码构建vision_core库和vision_app程序。
add_library(vision_core)
add_executable(vision_app src/main.cpp)
# vision_app使用vision_core，但不向其他target传播该依赖。
target_link_libraries(vision_app PRIVATE vision_core)
```

最后一行不仅表示链接顺序，还建立了target依赖：构建`vision_app`之前，CMake会先保证`vision_core`已经更新。后续应继续把头文件目录、编译宏和第三方依赖加到具体target，而不是依赖目录级全局状态。

## 2 自有项目源码与头文件的添加方法

### 2.1 `add_library`、`add_executable`与`target_sources`

`add_library`创建库target：

```cmake
# 创建一个由当前工程编译的静态库target。
add_library(vision_core STATIC)
```

- `vision_core`是CMake内部的target名。
- `STATIC`表示产生静态库；也可以使用`SHARED`产生动态库。
- 不写库类型时，行为会受到`BUILD_SHARED_LIBS`影响，因此需要固定产物类型时应明确写出。

`add_executable`创建可执行target：

```cmake
# 使用src/main.cpp创建可执行程序target。
add_executable(vision_app src/main.cpp)
```

`target_sources`可以在target创建之后补充源文件：

```cmake
# 给已经创建的vision_core补充实现文件和用于工程展示的头文件。
target_sources(vision_core
    PRIVATE
        src/image_info.cpp
        include/vision_app/image_info.hpp
)
```

这里把头文件列入target，主要方便IDE展示、代码审查和维护文件清单。真正需要编译的是`.cpp`；普通非模板头文件通常不会单独生成目标文件。

需要注意：`target_sources`中的`PRIVATE`表示这些文件不作为接口源文件传播。它不等于“这个头文件不能被用户包含”。头文件能否被下游包含，主要由头文件所在目录是否通过`target_include_directories`传播决定。

### 2.2 头文件路径与`#include`路径的对应关系

假设工程结构如下：

```text
project/
├── CMakeLists.txt
├── include/
│   └── vision_app/
│       └── image_info.hpp
└── src/
    ├── image_info.cpp
    └── main.cpp
```

代码写成：

```cpp
#include <vision_app/image_info.hpp>
```

编译器需要获得的搜索目录是`project/include`。编译器把搜索目录与`vision_app/image_info.hpp`拼接后，得到实际文件：

```text
project/include/vision_app/image_info.hpp
```

因此，不应把`project/include/vision_app`作为搜索目录，否则编译器会继续拼接`vision_app/image_info.hpp`，形成重复目录。

这个判断方法适用于自己的头文件和第三方头文件。例如代码包含：

```cpp
#include <opencv2/core.hpp>
```

那么提供给编译器的目录必须是内部直接包含`opencv2`子目录的那一级，而不是`opencv2`目录本身。

一个头文件根目录可以覆盖任意层级的子目录，但编译器不会按文件名递归搜索。例如添加`include`后，`#include <mylib/core/detail/buffer.hpp>`可以找到嵌套文件，`#include <buffer.hpp>`却不会自动遍历所有子目录。通常不必把每个`.h`列入`target_sources`，只需列出需要编译的`.cpp`并添加少量稳定的头文件根目录。`find_path`主要用于寻找第三方头文件的根目录，也不会把目录下的头文件逐个加入target。

### 2.3 `target_include_directories`添加头文件搜索目录

基本语法为：

```cmake
# 给指定target添加编译器头文件搜索目录，并声明传播范围。
target_include_directories(<target>
    <PRIVATE|PUBLIC|INTERFACE> <目录>...
)
```

一个只考虑当前源码树的简单库可以写成：

```cmake
# 分别声明需要向下游传播的公开目录和仅供当前库使用的私有目录。
target_include_directories(vision_core
    PUBLIC
        # 当前库和下游都需要公开头文件目录。
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
    PRIVATE
        # 只有当前库的实现文件需要src目录。
        "${CMAKE_CURRENT_SOURCE_DIR}/src"
)
```

- `CMAKE_CURRENT_SOURCE_DIR`表示当前`CMakeLists.txt`所在的源目录。
- `include`是公开头文件根目录，下游链接`vision_core`后也需要它，所以使用`PUBLIC`。
- `src`只保存库自身实现所需的私有头文件，下游不应依赖，因此使用`PRIVATE`。

可安装库还会使用`BUILD_INTERFACE`与`INSTALL_INTERFACE`区分源码树和安装后的路径。本阶段主项目不做库发布，先掌握target级目录和传播关系即可。

### 2.4 公开头文件与私有头文件的目录组织

推荐把公开接口和实现细节分开：

```text
include/vision_app/     # 其他target允许包含
src/                    # 当前库自己的实现和私有头文件
```

公开头文件应尽量只暴露稳定接口。若公开头文件直接包含某个第三方头文件，或者把第三方类型放进函数参数、返回值或成员声明，使用者在编译公开接口时也必须找到该第三方依赖。此时依赖可能需要向下游传播。

私有头文件可以调整实现结构，但不应成为其他target的依赖。若其他模块只能通过把`src`目录加入搜索路径才能工作，说明模块边界已经被破坏。

### 2.5 将头文件列入target与添加头文件搜索目录的区别

两种操作解决的问题不同：

- `target_sources`列出头文件：告诉CMake和IDE“这个文件属于该target”。
- `target_include_directories`添加目录：告诉编译器“遇到`#include`时从哪些目录开始搜索”。

因此，出现头文件找不到时，不能只检查它是否出现在`target_sources`中。应根据`#include`内容，从右向左推导应该添加哪个父目录，再检查这个目录是否以正确作用域加到了真正编译该`.cpp`的target。

若只是为了让IDE展示所有头文件，可以使用`file(GLOB_RECURSE)`生成文件清单，但它仍不能替代`target_include_directories`。CMake也不推荐用递归通配自动收集需要参与构建的源文件；对编译而言，最简单的做法仍是明确列出`.cpp`，不必枚举所有头文件。

## 3 `PUBLIC`、`PRIVATE`与`INTERFACE`的传播规则

### 3.1 当前target使用与下游target继承

这三个关键词描述的是**使用要求（usage requirements）**由谁消费：

| 作用域 | 当前target使用 | 链接当前target的下游使用 |
|---|---:|---:|
| `PRIVATE` | 是 | 否 |
| `PUBLIC` | 是 | 是 |
| `INTERFACE` | 否 | 是 |

判断时不要从英文名称猜，而要回答两个问题：当前target编译或链接时需要它吗？下游编译或链接时也需要它吗？

`PRIVATE`只表示CMake不把这项使用要求自动传播给下游，不会加密、删除或隐藏磁盘上的头文件。若不想交付私有实现，应把公开头文件放在`include`、私有头文件放在`src`，安装时只复制公开头文件，并只发布库文件；需要进一步隐藏类的内部成员时可以使用PImpl。只要源码目录已经交给对方，对方仍可能手工添加路径读取私有头文件。

### 3.2 头文件目录的传播

若`vision_core`的公开头文件位于`include`目录：

```cmake
# 公开头文件目录由vision_core传播给使用者。
target_include_directories(vision_core PUBLIC include)
# vision_app链接库后自动获得上述公开目录。
target_link_libraries(vision_app PRIVATE vision_core)
```

`vision_core`自己编译时能使用`include`，`vision_app`也会继承该目录。`vision_app`不需要重复写相同的`target_include_directories`。

若把`PUBLIC`误写为`PRIVATE`，库自身可能仍能构建，但下游包含`vision_core`公开头文件时会失败。这是验证传播关系最直接的方法。

### 3.3 链接依赖的传播

`target_link_libraries`同样使用这三个作用域：

```cmake
# helper_library只服务于vision_core自身，不向下游传播。
target_link_libraries(vision_core PRIVATE helper_library)
```

表示`vision_core`自身需要`helper_library`，但它不应成为普通下游的接口依赖。

```cmake
# 当前库和使用当前库的下游都需要public_dependency。
target_link_libraries(vision_core PUBLIC public_dependency)
```

表示当前库和下游都需要该依赖。CMake会把目标的直接链接需求与链接接口分别保存，并根据target关系生成最终链接命令。详见CMake官方[`target_link_libraries`](https://cmake.org/cmake/help/latest/command/target_link_libraries.html)文档。

不要把链接器选项伪装成普通库传播。链接器专用选项优先使用`target_link_options`，编译器选项使用`target_compile_options`。

### 3.4 第三方类型出现在公开接口时的依赖传播

假设公开头文件直接声明：

```cpp
#include <third_party/image.hpp>

third_party::Image preprocess(const third_party::Image& input);
```

任何包含这个公开头文件的下游都必须认识`third_party::Image`，因此第三方头文件目录必须传播。若第三方包提供导入target，通常应写成：

```cmake
# 公开接口暴露了第三方类型，因此向下游传播第三方依赖。
target_link_libraries(vision_core PUBLIC ThirdParty::Image)
```

若第三方类型只出现在`vision_core.cpp`中，而公开头文件完全不暴露它，通常使用`PRIVATE`即可。这里的原则不是“第三方库都要PUBLIC”，而是公开接口是否把该依赖变成了下游编译所需的条件。

## 4 第三方库的源码、构建产物与安装目录

### 4.1 第三方库的头文件、静态库、动态库与运行时文件

一个C++第三方库通常不只是单个库文件，而是若干相互配合的产物：

- **公开头文件**：提供类型、函数声明和模板定义，供编译器读取。
- **静态库**：Linux常见`.a`，Windows常见`.lib`；其代码通常被链接进最终产物。
- **动态库**：Linux常见`.so`，Windows运行时文件为`.dll`；程序启动或运行时加载。
- **Windows导入库**：链接DLL时经常还需要`.lib`，它不是运行时DLL本身。
- **包配置文件**：记录版本、组件、头文件目录、库位置和传递依赖，供`find_package`加载。
- **插件与资源**：部分库还需要后端插件、配置文件或模型，不能只复制主库。

编译、链接、运行使用的文件不同，所以“库已经下载”不能证明C++项目一定可以使用它。

### 4.2 安装前缀中的`include`、`lib`、`bin`与CMake包配置

安装前缀是第三方库安装树的根目录。常见结构类似：

```text
<prefix>/
├── include/
├── lib/
│   └── cmake/<PackageName>/
├── bin/
└── share/
```

Linux中前缀可能是`/usr`、`/usr/local`或`/opt/opencv`；Windows中可能是`C:/third_party/opencv-install`。具体子目录由库和平台决定，不能假定所有库完全相同。

`lib/cmake/<PackageName>`常用于放置`<PackageName>Config.cmake`，但这只是常见约定。真正判断依据是配置文件的实际位置和该包的官方文档。

### 4.3 第三方库生产者与业务项目使用者的CMake职责

第三方库的维护者是**生产者**。它的CMake负责：

1. 创建库target；
2. 声明公开头文件、编译宏和间接依赖；
3. 构建静态库或动态库；
4. 安装头文件、库和运行时文件；
5. 生成包配置文件或导出target。

业务项目是**使用者**。使用者通常只需要：

1. 让CMake找到包；
2. 选择需要的组件；
3. 把包提供的target链接到自己的target。

因此，调用OpenCV时通常不应复制或修改OpenCV源码中的大型`CMakeLists.txt`。如果使用安装好的OpenCV，应消费它提供的`OpenCVConfig.cmake`和相关结果。

### 4.4 系统安装、源码内置、包管理器与预编译库的区别

| 方式 | CMake中的常见入口 | 适用情况 | 主要注意事项 |
|---|---|---|---|
| 系统或手工安装 | `find_package` | 多个项目共享依赖 | 版本和系统权限 |
| 源码放入仓库 | `add_subdirectory` | 小型、稳定、易一起构建的库 | 构建选项可能污染主工程 |
| `FetchContent` | 获取后提供target | 希望配置时取得源码 | 网络、缓存和版本锁定 |
| vcpkg、Conan等包管理器 | toolchain或依赖提供器 | 多平台依赖管理 | 必须统一triplet、编译器和配置 |
| 仅有头文件和预编译库 | `find_path`、`find_library`、导入target | SDK或旧库 | 路径、架构和运行时文件需自行核对 |

OpenCV构建庞大，通常更适合系统包、预编译包、包管理器或单独构建安装，而不是作为普通子目录每次随业务工程重编。

## 5 CMake查找第三方库的机制

### 5.1 `find_package`的Module模式与Config模式

`find_package(PackageName)`用于查找外部包并加载包提供的信息。它主要有两种模式：

- **Module模式**：查找`FindPackageName.cmake`。这个模块通常由CMake、业务项目或其他外部来源提供，再按规则搜索头文件和库。
- **Config模式**：查找`PackageNameConfig.cmake`、`packagename-config.cmake`等由包安装的配置文件。配置文件了解包自身的组件和依赖，通常比外部猜测更可靠。

常用基本语法：

```cmake
# 查找必需的包，并只请求当前工程实际使用的组件。
find_package(PackageName REQUIRED COMPONENTS component_a component_b)
```

- `REQUIRED`表示找不到时立即终止配置。
- `COMPONENTS`只请求实际需要的组件，前提是该包支持组件选择。
- 找到后通常会设置`PackageName_FOUND`，还可能提供变量和导入target。

CMake官方[`find_package`](https://cmake.org/cmake/help/latest/command/find_package.html)文档给出了两种模式、配置文件名称和完整搜索过程。

### 5.2 `<Package>Config.cmake`包配置文件

Config模式找到包配置文件后，会执行其中的CMake代码。这个文件通常负责：

- 检查请求版本和组件；
- 定义导入target；
- 填充头文件、库和版本变量；
- 查找该包自己的间接依赖。

如果强制使用Config模式：

```cmake
# 只使用OpenCV自身安装的Config包；找不到就终止配置。
find_package(OpenCV CONFIG REQUIRED)
```

CMake会把实际使用的配置文件路径保存在标准的`OpenCV_CONFIG`变量中。调试时可以输出：

```cmake
# 输出本次配置实际加载的OpenCVConfig.cmake路径。
message(STATUS "OpenCV config: ${OpenCV_CONFIG}")
```

这比只看到“OpenCV found”更有价值，因为一台机器上可能同时存在多个版本。

### 5.3 CMake默认搜索位置与安装前缀

CMake会组合多类前缀进行搜索，包括包专用根目录、`CMAKE_PREFIX_PATH`、系统环境、平台默认安装前缀和包注册信息。Linux中的`/usr/local`就是常见系统前缀之一。

因此，库不必放在某个唯一目录。它只需要：

1. 安装在CMake默认能够搜索的前缀下；或
2. 由使用者明确提供安装前缀；或
3. 直接提供包含包配置文件的目录。

不要把“头文件所在目录”“库文件所在目录”“安装前缀”“配置文件所在目录”混成一个路径。它们可能有关联，但用途不同。

### 5.4 `CMAKE_PREFIX_PATH`与`<Package>_DIR`的区别

`CMAKE_PREFIX_PATH`保存一个或多个**安装前缀**。例如OpenCV安装在：

```text
/opt/opencv/include/...
/opt/opencv/lib/...
/opt/opencv/lib/cmake/opencv4/OpenCVConfig.cmake
```

则可以配置：

```bash
cmake -S . -B build -DCMAKE_PREFIX_PATH=/opt/opencv
```

CMake会在该前缀下继续检查常见子目录。官方文档说明，`CMAKE_PREFIX_PATH`会被`find_package`、`find_library`和`find_path`等命令使用，并自动追加各命令需要的子目录，参见[`CMAKE_PREFIX_PATH`](https://cmake.org/cmake/help/latest/envvar/CMAKE_PREFIX_PATH.html)。

`<Package>_DIR`则通常指向**直接包含包配置文件的目录**。OpenCV示例：

```bash
cmake -S . -B build \
  -DOpenCV_DIR=/opt/opencv/lib/cmake/opencv4
```

二者区别可以记成：

- `CMAKE_PREFIX_PATH=/opt/opencv`：给CMake一个安装树的起点。
- `OpenCV_DIR=/opt/opencv/lib/cmake/opencv4`：直接告诉它`OpenCVConfig.cmake`所在目录。

不要把`OpenCV_DIR`指向`include/opencv4`或某个`.so`文件。OpenCV官方安装说明同样要求`OpenCV_DIR`指向包含`OpenCVConfig.cmake`的构建或安装位置，参见[OpenCV安装概览](https://docs.opencv.org/4.13.0/d0/d3d/tutorial_general_install.html)。

这些本机路径优先从命令行、CMake Preset或包管理器toolchain传入，不要硬编码进需要在多台机器使用的`CMakeLists.txt`。

### 5.5 CMake缓存对包查找结果的影响

CMake首次配置后会把编译器、包目录和很多查找结果写入构建目录中的`CMakeCache.txt`。即使后来修改了环境变量，旧构建目录仍可能继续使用缓存路径。

排查时先输出实际配置路径，并检查缓存：

```bash
cmake -LAH -N build
```

若需要验证另一套OpenCV，不必立即删除原构建目录，可以新建构建目录：

```bash
cmake -S . -B build-opencv-new \
  -DOpenCV_DIR=/new/prefix/lib/cmake/opencv4
```

这能保留原构建结果，同时确认问题是否来自旧缓存。更换编译器、CPU架构或交叉编译toolchain时尤其应该使用新的构建目录。

### 5.6 `find_path`与`find_library`的手工查找场景

当旧SDK没有提供Config包，也没有可靠的Find模块时，可以分别查找头文件和库：

```cmake
# 找到能够使#include <legacy/api.hpp>成立的头文件根目录。
find_path(Legacy_INCLUDE_DIR
    NAMES legacy/api.hpp
    REQUIRED
)

# 找到名为legacy的实际库文件。
find_library(Legacy_LIBRARY
    NAMES legacy
    REQUIRED
)
```

- `find_path`返回能够使`#include <legacy/api.hpp>`成立的父目录。
- `find_library`返回具体库文件路径。

随后应把结果封装为导入target：

```cmake
# 用一个CMake逻辑target代表已经在工程外编译完成的库。
add_library(Legacy::Legacy UNKNOWN IMPORTED)
set_target_properties(Legacy::Legacy PROPERTIES
    # 第三方库文件的实际位置。
    IMPORTED_LOCATION "${Legacy_LIBRARY}"
    # 链接该target的使用者需要继承的头文件目录。
    INTERFACE_INCLUDE_DIRECTORIES "${Legacy_INCLUDE_DIR}"
)
```

业务target再链接`Legacy::Legacy`。这样头文件和库位置被封装在同一个依赖对象里，避免每个调用方重复拼路径。实际SDK若区分Debug、Release或Windows导入库，还需要设置对应配置属性；这时优先寻找厂商提供的正式CMake包。

## 6 第三方库头文件和库文件的接入方法

### 6.1 导入target携带的头文件、库和传递依赖

**导入target（imported target）**是CMake中代表“已经在当前工程之外构建完成的库”的逻辑对象，不是新的库文件，也不会重新编译第三方源码。通常由`find_package`加载的包配置创建；`Package::Component`只是常见的“包名::组件名”命名方式。

```cmake
# 使用第三方包提供的组件；该组件target记录了怎样使用真实库。
target_link_libraries(vision_app PRIVATE Package::Component)
```

一个完善的导入target可能携带：

- 头文件目录，就不用再导入头文件；
- 对应配置的库文件位置；
- 必需编译宏；
- 间接链接依赖；
- 平台专用选项。

这里的“携带”是指这些信息保存在target的`IMPORTED_*`和`INTERFACE_*`属性中，并不是把头文件和库复制进target。`vision_app`链接它后，CMake会自动把必要的头文件目录、库和间接依赖加入编译或链接命令。一个第三方包可以提供多个组件target，例如核心库、图形库和网络库各一个。

因此，优先链接包提供的target，而不是把头文件和库路径拆开硬编码。准确target名必须查该包当前版本的官方文档或查看包配置，不能把`OpenCV::Core`之类名字想当然地写入工程。

### 6.2 包配置变量与target级头文件目录

一些包仍主要提供变量，例如：

```cmake
# 变量方式需要使用者自己添加第三方头文件目录。
target_include_directories(vision_app PRIVATE ${Package_INCLUDE_DIRS})
# 再手工添加包配置返回的库列表。
target_link_libraries(vision_app PRIVATE ${Package_LIBRARIES})
```

导入target方式与变量方式解决的是同一个问题，只是封装程度不同：前者把头文件、库和间接依赖封装在`Package::Component`中，后者把路径和库列表交给使用者自行组合。某些包只提供其中一种，也有包同时提供两种；有稳定导入target时优先使用它，通常不要再同时重复添加对应变量。

变量方式本身不是错误，但要注意：

- 使用`target_include_directories`，不要用目录级`include_directories`污染所有target；
- 使用包实际文档中的变量名；
- 输出变量确认它们来自期望安装位置；
- 变量可能只是一串路径或库名，不一定完整表达所有传递依赖。

### 6.3 `target_link_libraries`连接第三方库

基本语法：

```cmake
# 把库或CMake target连接到指定target，并决定是否向下游传播。
target_link_libraries(<target>
    <PRIVATE|PUBLIC|INTERFACE> <库或target>...
)
```

对于可执行程序，第三方库通常使用`PRIVATE`，因为可执行程序没有继续被普通下游链接的公开接口。对于库target，则根据第3.4节判断第三方类型是否进入公开接口。

链接CMake target还有一个重要好处：CMake知道库文件的完整位置和target之间的构建依赖，通常比手写`-L`、`-l`或裸文件路径更稳定。

### 6.4 编译期搜索路径与运行时动态库搜索路径的区别

第三方库接入至少涉及三条路径链：

1. **CMake配置期**：`find_package`找到包配置文件。
2. **编译与链接期**：编译器找到头文件，链接器找到库或导入库。
3. **程序运行期**：动态加载器找到`.so`、`.dll`等运行时文件。

`CMAKE_PREFIX_PATH`和`OpenCV_DIR`主要解决第1条；导入target和`target_include_directories`、`target_link_libraries`解决第2条；RPATH、系统动态库配置、`LD_LIBRARY_PATH`或Windows `PATH`解决第3条。

Linux中临时设置`LD_LIBRARY_PATH`可以验证是否属于运行时搜索问题，但正式部署更适合使用系统安装、应用目录布局或经过设计的RPATH。Windows中常把项目所需DLL部署到可执行文件旁，或把对应`bin`目录加入运行环境的`PATH`。不要用运行时环境变量掩盖CMake配置期没有找到开发包的问题。

## 7 OpenCV计算机视觉库的CMake接入流程

### 7.1 OpenCV C++开发包与Python `cv2`包的区别

OpenCV（Open Source Computer Vision Library）是开源计算机视觉库。阶段1-3已经使用过其Core模块。本节关心的是C++开发接口，它通常需要：

- `opencv2/...`头文件；
- OpenCV静态库或动态库；
- CMake包配置；
- 动态构建对应的运行时库和可能的插件。

`pip install opencv-python`主要安装Python解释器使用的`cv2`包，不能默认等同于一套可供普通C++工程使用的头文件、链接库和`OpenCVConfig.cmake`。C++项目应安装系统开发包、预编译C++ SDK、包管理器版本，或自己构建安装OpenCV。

### 7.2 OpenCV安装目录与`OpenCVConfig.cmake`

不同来源的目录结构不同。Linux从源码安装到`/opt/opencv`后，配置文件可能位于：

```text
/opt/opencv/lib/cmake/opencv4/OpenCVConfig.cmake
```

Windows预编译包的路径可能带有架构和Visual Studio工具集目录。不要背某个固定路径，应实际搜索`OpenCVConfig.cmake`：

Linux：

```bash
find /opt/opencv -name OpenCVConfig.cmake -print
```

Windows PowerShell：

```powershell
Get-ChildItem -Path C:\opencv -Filter OpenCVConfig.cmake -Recurse
```

找到后，包含该文件的目录才是可传给`OpenCV_DIR`的候选目录。

### 7.3 `CMAKE_PREFIX_PATH`与`OpenCV_DIR`

若OpenCV拥有规范安装树，优先提供安装前缀：

```bash
cmake -S . -B build -DCMAKE_PREFIX_PATH=/opt/opencv
```

若机器上有多个OpenCV版本，或者默认搜索失败，可以直接指定配置目录：

```bash
cmake -S . -B build \
  -DOpenCV_DIR=/opt/opencv/lib/cmake/opencv4
```

Windows PowerShell示意：

```powershell
cmake -S . -B build `
  -DOpenCV_DIR="C:/实际路径/包含OpenCVConfig.cmake的目录"
```

Windows路径在CMake参数中使用正斜杠通常更容易避免转义问题。不要把某台机器的绝对路径写进通用`CMakeLists.txt`。

### 7.4 `find_package(OpenCV)`的查找结果

只需要Core组件时可以写：

```cmake
# 查找OpenCV自身的Config包，并只请求Core组件。
find_package(OpenCV CONFIG REQUIRED COMPONENTS core)

# 输出查找结果，确认版本、配置文件、头文件目录和库列表。
message(STATUS "OpenCV version: ${OpenCV_VERSION}")
message(STATUS "OpenCV config: ${OpenCV_CONFIG}")
message(STATUS "OpenCV include dirs: ${OpenCV_INCLUDE_DIRS}")
message(STATUS "OpenCV libraries: ${OpenCV_LIBS}")
```

这里强制使用Config模式，是为了明确加载OpenCV自身提供的配置文件。输出内容用于验证：

- 版本是否符合预期；
- 实际读取的是哪个配置文件；
- 头文件是否来自目标安装树；
- 请求的组件产生了哪些链接库。

OpenCV官方教程的基本流程也是先`find_package(OpenCV REQUIRED)`，再使用其头文件和库变量，参见[Using OpenCV with gcc and CMake](https://docs.opencv.org/4.12.0/db/df5/tutorial_linux_gcc_cmake.html)。

### 7.5 `OpenCV_INCLUDE_DIRS`与`OpenCV_LIBS`

OpenCV传统且常见的使用方式是：

```cmake
# 将OpenCV头文件目录只添加给当前探测程序。
target_include_directories(opencv_probe PRIVATE ${OpenCV_INCLUDE_DIRS})
# 将OpenCV配置返回的库列表链接给当前探测程序。
target_link_libraries(opencv_probe PRIVATE ${OpenCV_LIBS})
```

- `OpenCV_INCLUDE_DIRS`给编译器提供`opencv2`目录的父目录。
- `OpenCV_LIBS`给链接器提供所选组件需要的库。
- `PRIVATE`表示这些要求只服务于当前探测程序。

一些OpenCV构建还会暴露可直接链接的target。使用前应检查当前包配置和官方文档所列的准确名字；如果包提供了稳定导入target，优先使用它，让头文件、库和间接依赖一起传播。

### 7.6 OpenCV头文件、链接库与运行时动态库验证

接入成功需要逐层验证：

1. CMake输出正确的`OpenCV_CONFIG`和版本；
2. 代码能包含`<opencv2/core.hpp>`；
3. 调用OpenCV非内联函数后仍能链接成功；
4. 程序运行成功；
5. 动态构建时，运行依赖来自期望安装目录。

Linux可以检查：

```bash
ldd ./build/opencv_probe
```

如果输出中的`libopencv_core.so`显示`not found`，说明配置和链接可能已经成功，但运行环境找不到OpenCV动态库。若它指向另一个旧版本，也说明运行环境与配置阶段使用的版本不一致。


## 8 Debug、Release、测试target与交叉编译toolchain文件

### 8.1 单配置与多配置构建

Makefiles和Ninja通常是单配置生成器，配置时选择构建类型：

```bash
cmake -S . -B build-debug -DCMAKE_BUILD_TYPE=Debug
cmake --build build-debug

cmake -S . -B build-release -DCMAKE_BUILD_TYPE=Release
cmake --build build-release
```

Visual Studio等通常是多配置生成器，构建时选择：

```powershell
cmake -S . -B build-vs
cmake --build build-vs --config Debug
cmake --build build-vs --config Release
```

因此，不能假定设置`CMAKE_BUILD_TYPE`对所有生成器都有效。

### 8.2 target级编译选项

编译选项应尽量绑定到需要它的target：

```cmake
# 根据当前编译器，只给vision_core添加对应的警告选项。
target_compile_options(vision_core PRIVATE
    $<$<CXX_COMPILER_ID:GNU,Clang>:-Wall;-Wextra>
    $<$<CXX_COMPILER_ID:MSVC>:/W4>
)
```

`$<...>`是生成器表达式，会在生成构建规则时根据条件选择内容。这里仅需理解它按编译器选择警告选项，不需要展开完整语法。

阶段1-1和1-5使用过ASan、TSan。将消毒器选项加入实际target时，通常既需要编译插桩选项，也需要相应链接选项；下一节阶段1-8会继续讨论调试工具。

### 8.3 测试target与CTest

CTest是CMake配套的测试运行工具。最小接入过程：

```cmake
# 启用当前项目的CTest测试注册功能。
enable_testing()

# 创建测试程序并连接被测试的vision_core库。
add_executable(vision_core_test tests/vision_core_test.cpp)
target_link_libraries(vision_core_test PRIVATE vision_core)

# 把测试程序注册为可由ctest执行的测试项。
add_test(NAME vision_core_test COMMAND vision_core_test)
```

`add_executable`只构建测试程序；`add_test`才把它注册给CTest。测试程序应在成功时返回0，失败时返回非0，使自动化工具能够判断结果。

运行：

```bash
ctest --test-dir build --output-on-failure
```

多配置生成器还需要指定配置，例如`ctest --test-dir build-vs -C Debug --output-on-failure`。

### 8.4 交叉编译toolchain文件的作用

**工具链文件（toolchain file）**是在CMake首次配置早期读取的文件，用于说明目标平台和编译工具。它通常设置：

- `CMAKE_SYSTEM_NAME`：目标系统；
- C和C++交叉编译器；
- `CMAKE_SYSROOT`：目标系统根目录；
- 查找程序、库、头文件和包时的根路径策略。

使用示意：

```bash
cmake -S . -B build-arm \
  -DCMAKE_TOOLCHAIN_FILE=cmake/toolchains/arm-linux.cmake
```

toolchain必须在首次配置构建目录时生效。更换工具链后应创建新的构建目录，不能依赖旧缓存。它解决“用哪套编译器、为哪个系统构建、到哪个sysroot找依赖”，不负责描述普通业务模块关系。



## 9 自有库公开头文件与测试target集成Demo

本Demo只依赖CMake和C++17标准库，验证三个知识点：公开头文件目录能否传播、下游是否只需链接库target、测试是否能被CTest执行。

目录结构：

```text
stage17_headers/
├── CMakeLists.txt
├── include/
│   └── stage17/
│       └── math.hpp
├── src/
│   └── math.cpp
├── app/
│   └── main.cpp
└── tests/
    └── test_math.cpp
```

公开头文件`include/stage17/math.hpp`：

```cpp
#pragma once

namespace stage17 {

// 返回两个整数之和。本函数不取得任何外部资源，也不修改调用方状态。
int add(int left, int right) noexcept;

}  // namespace stage17
```

实现文件`src/math.cpp`：

```cpp
#include <stage17/math.hpp>

namespace stage17 {

int add(int left, int right) noexcept {
    return left + right;
}

}  // namespace stage17
```

主程序`app/main.cpp`：

```cpp
#include <iostream>
#include <stage17/math.hpp>

int main() {
    const int result = stage17::add(20, 22);
    std::cout << "20 + 22 = " << result << '\n';

    // 返回0表示主程序正常完成；输出应为42。
    return 0;
}
```

测试程序`tests/test_math.cpp`：

```cpp
#include <iostream>
#include <stage17/math.hpp>

int main() {
    const int actual = stage17::add(20, 22);
    constexpr int expected = 42;

    if (actual != expected) {
        // 非0返回值会让CTest把本次测试标记为失败，并保留实际结果用于排查。
        std::cerr << "expected " << expected << ", got " << actual << '\n';
        return 1;
    }

    std::cout << "stage17_math test passed\n";
    return 0;
}
```

根目录`CMakeLists.txt`：

```cmake
cmake_minimum_required(VERSION 3.20)
project(stage17_headers LANGUAGES CXX)

# 创建静态库target。先创建再用target_sources补充文件，便于后续分模块维护。
add_library(stage17_math STATIC)

target_sources(stage17_math
    PRIVATE
        src/math.cpp
        # 列出头文件便于IDE和代码审查识别；这一步本身不会建立#include搜索路径。
        include/stage17/math.hpp
)

target_include_directories(stage17_math
    PUBLIC
        # 代码包含<stage17/math.hpp>，所以搜索根目录必须是include这一层。
        "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

# 下游也按C++17编译，因此使用PUBLIC传播这一编译特性要求。
target_compile_features(stage17_math PUBLIC cxx_std_17)

add_executable(stage17_app app/main.cpp)
# app不重复添加include目录；链接stage17_math后自动继承其PUBLIC头文件目录。
target_link_libraries(stage17_app PRIVATE stage17_math)

enable_testing()
add_executable(stage17_math_test tests/test_math.cpp)
target_link_libraries(stage17_math_test PRIVATE stage17_math)

# 测试程序返回0时通过，返回非0时CTest报告失败。
add_test(NAME stage17_math_test COMMAND stage17_math_test)
```

Linux单配置构建和运行：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
./build/stage17_app
ctest --test-dir build --output-on-failure
```

预期主程序输出：

```text
20 + 22 = 42
```

CTest应报告`stage17_math_test`通过。验收时重点确认：

1. `app`和`tests`没有重复添加`include`目录；
2. `stage17_math`的`PUBLIC`目录通过链接关系传播；
3. 把头文件列入`target_sources`不是传播发生的原因；
4. 测试失败路径返回1，CTest能够观察到失败。

Visual Studio等多配置构建可使用：

```powershell
cmake -S . -B build-vs
cmake --build build-vs --config Debug
ctest --test-dir build-vs -C Debug --output-on-failure
```

## 10 OpenCV查找、头文件接入、链接与运行验证Demo

本Demo只验证OpenCV C++开发包的接入链路，不处理图像。程序调用`cv::getBuildInformation()`：这个OpenCV Core模块函数返回当前OpenCV库的构建信息。它不是单纯的头文件宏，因此成功执行可以同时证明头文件、链接库和运行时动态库链路可用。

目录结构：

```text
opencv_probe/
├── CMakeLists.txt
└── main.cpp
```

`main.cpp`：

```cpp
#include <iostream>
#include <string>
#include <opencv2/core.hpp>

int main() {
    // getBuildInformation由OpenCV Core库提供实现。
    // 若只找到头文件却没有正确链接Core库，本程序会在链接阶段失败。
    const std::string& build_information = cv::getBuildInformation();

    if (build_information.empty()) {
        // 正常OpenCV构建应返回非空信息；非0表示验证失败，便于脚本和CTest识别。
        std::cerr << "OpenCV build information is empty\n";
        return 1;
    }

    std::cout << "OpenCV version: " << CV_VERSION << '\n';
    std::cout << build_information << '\n';
    return 0;
}
```

`CMakeLists.txt`：

```cmake
cmake_minimum_required(VERSION 3.20)
project(opencv_probe LANGUAGES CXX)

# 强制使用OpenCV自身提供的Config包，只请求当前程序需要的Core组件。
find_package(OpenCV CONFIG REQUIRED COMPONENTS core)

# 配置阶段输出证据，确认没有误用机器上的另一个OpenCV版本。
message(STATUS "OpenCV version: ${OpenCV_VERSION}")
message(STATUS "OpenCV config: ${OpenCV_CONFIG}")
message(STATUS "OpenCV include dirs: ${OpenCV_INCLUDE_DIRS}")
message(STATUS "OpenCV libraries: ${OpenCV_LIBS}")

add_executable(opencv_probe main.cpp)
target_compile_features(opencv_probe PRIVATE cxx_std_17)

# OpenCV官方配置提供头文件和库变量；只把它们加给当前探测target。
target_include_directories(opencv_probe PRIVATE ${OpenCV_INCLUDE_DIRS})
target_link_libraries(opencv_probe PRIVATE ${OpenCV_LIBS})
```

Linux中，如果OpenCV已经安装在默认系统前缀：

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/opencv_probe
ldd ./build/opencv_probe
```

如果安装在`/opt/opencv`，可使用安装前缀：

```bash
cmake -S . -B build-prefix \
  -DCMAKE_PREFIX_PATH=/opt/opencv \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build-prefix
./build-prefix/opencv_probe
```

也可以直接指定配置文件目录：

```bash
cmake -S . -B build-dir \
  -DOpenCV_DIR=/opt/opencv/lib/cmake/opencv4 \
  -DCMAKE_BUILD_TYPE=Release
cmake --build build-dir
./build-dir/opencv_probe
```

Windows PowerShell中，将占位路径替换为实际包含`OpenCVConfig.cmake`的目录：

```powershell
cmake -S . -B build `
  -DOpenCV_DIR="C:/实际路径/包含OpenCVConfig.cmake的目录"
cmake --build build --config Release
.\build\Release\opencv_probe.exe
```

如果所选生成器把可执行文件放在其他目录，应以构建输出为准。程序至少应打印OpenCV版本和非空构建信息。

验收时回答以下问题：

1. `OpenCV_CONFIG`实际指向哪个文件？
2. `OpenCV_INCLUDE_DIRS`中的哪一级目录使`<opencv2/core.hpp>`可见？
3. `OpenCV_LIBS`中哪个组件提供`cv::getBuildInformation()`？
4. Linux的`ldd`最终把OpenCV Core解析到了哪个`.so`？
5. 若改用另一套OpenCV，能否只改变配置参数和构建目录，不修改`main.cpp`？

若配置失败，先找`OpenCVConfig.cmake`；若编译报头文件不存在，检查`OpenCV_INCLUDE_DIRS`；若链接报未定义符号，检查Core组件和实际链接命令；若程序启动失败，检查动态库部署和运行时搜索路径。这样就能沿同一条依赖链定位问题，而不是随机增加环境变量。

## 11 最小CMake修改、第三方库接入与排错能力检查

完成本节后，应能在不查完整模板的情况下写出最小核心关系：

```cmake
# 创建业务库并公开它的头文件根目录。
add_library(core STATIC src/core.cpp)
target_include_directories(core PUBLIC include)

# 创建程序并使用core；公开头文件目录会随链接关系传播。
add_executable(app src/main.cpp)
target_link_libraries(app PRIVATE core)
```

还应能够完成以下检查：

1. 看到`#include <a/b.hpp>`，能推导应该添加包含`a`目录的父目录。
2. 能说明`target_sources`列出头文件与`target_include_directories`添加搜索路径的区别。
3. 能根据“当前target是否需要、下游是否需要”选择`PUBLIC`、`PRIVATE`或`INTERFACE`。
4. 能说明第三方安装树中头文件、库、包配置和运行时文件各自的作用。
5. 能区分`CMAKE_PREFIX_PATH`的安装前缀与`OpenCV_DIR`的配置文件目录。
6. 找到包后，优先使用包提供的导入target；包只提供变量时，使用target级命令连接头文件和库。
7. 能区分CMake查包、编译找头文件、链接找符号和运行找动态库四类错误。
8. 能创建一个测试target并用CTest判断返回状态。
9. 知道toolchain文件在交叉编译中指定目标系统、编译器和sysroot，并应在新的构建目录首次配置。
10. 能审查AI或IDE生成的CMake，移除无依据的全局配置、硬编码本机路径和重复依赖。

面试通常不要求默写大型`CMakeLists.txt`，但应能写出上述核心几行，并结合一个真实项目解释：哪个target拥有源码，哪个目录是公开接口，第三方包如何被发现，链接关系怎样传播，以及程序运行时到哪里寻找动态库。
