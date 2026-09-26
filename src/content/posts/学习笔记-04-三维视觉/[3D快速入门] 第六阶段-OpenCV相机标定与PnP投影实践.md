---
title: '[3D快速入门] OpenCV相机标定与PnP投影实践'
published: 2026-09-25T08:04:00+08:00
description: '面向三维视觉入门与工程理解，介绍OpenCV相机标定与PnP投影实践的核心原理、常用方法与实践要点。'
tags: ['计算机视觉', '三维视觉', '3D']
category: '3D快速入门'
draft: false
lang: zh_CN
---

# [3D快速入门] 第六阶段 OpenCV 相机标定与 PnP 投影实践

本篇把前面讲过的几何关系对应到实际 C++ 调用：先通过多张棋盘格照片得到相机内参和畸变参数，再用一张照片求棋盘位姿，最后计算模型点的三维坐标和像素投影。

标定原理见第四阶段第 8 节，PnP 的用途见第五阶段第 3 节。本篇重点是数据怎样组织、核心函数怎样调用、输出接下来怎样使用。

两个 Demo 都采用 C++17 和 OpenCV。为突出计算过程，代码假定图片存在、尺寸一致、棋盘规格正确且角点检测成功，省略所有安全判断、绘图和显示。它们是学习用的最小实现，输入有误时可能直接触发 OpenCV 异常。

## 1 相机标定与 PnP 的整体流程

### 1.1 相机标定流程

1. 准备同一相机拍摄的多张不同姿态的棋盘照片。
2. 指定内角点的列数、行数和方格实际边长。
3. 构造棋盘角点在物体空间中的三维坐标。
4. 在每张照片中检测对应的二维角点。
5. 精化角点位置，并按照片收集 3D–2D 对应点。
6. 调用 `calibrateCamera()` 得到内参、畸变参数和各照片的棋盘位姿。
7. 保存第二个程序需要的相机参数和棋盘规格。

主要可复用结果是内参 $K$ 和畸变参数 $D$。每张标定照片的旋转、平移只描述那一刻棋盘相对于相机的姿态。

### 1.2 PnP、重投影与三维投影流程

1. 读取已保存的 $K、D$ 和棋盘规格。
2. 读取一张相同成像模式下的棋盘照片。
3. 构造模型三维点，检测照片中的对应二维点。
4. 调用 `solvePnP()` 得到当前棋盘的 `rvec、tvec`。
5. 把旋转向量转成矩阵，计算模型点在相机空间中的三维坐标。
6. 将棋盘角点重新投回图像，计算重投影误差。
7. 定义虚拟立方体的八个模型顶点，将它们投影成八个像素坐标。

这里有两个独立方向：PnP 根据已知模型和图像对应点求位姿；投影则使用已知位姿，把三维模型点转换成像素位置。

## 2 使用 OpenCV 完成相机标定

### 2.1 准备照片和棋盘规格

自己采集时建议先准备约 10～20 张清晰照片，覆盖不同距离、倾角和画面位置。照片数量只是实践建议，重复拍摄几乎相同的姿态不会提供充分的几何约束。镜头、变焦、对焦和输出模式应尽量保持一致。

参考代码列出了 `left01.jpg` 到 `left14.jpg` 的 13 张候选图，列表中没有 `left10.jpg`。本篇沿用这个列表，并以已成功检测的输入为运行前提。样本可从 [OpenCV 官方 samples/data 目录](https://github.com/opencv/opencv/tree/4.x/samples/data) 获取。

棋盘规格采用：

```cpp
cv::Size boardSize(9, 6);    // 每行 9 个内角点，共 6 行
float squareSize = 0.025f;  // 学习示例假定方格边长为 0.025 米
```

`Size(9,6)` 表示内角点数量，共 $9\times6=54$ 点。它不表示格子数量；完整的 $10\times7$ 方格棋盘具有 $9\times6$ 个内角点。

方格边长决定三维模型和输出平移的尺度。自己拍摄时应提供实测边长。官方照片的真实方格尺寸不能仅由图像确认，本篇的 25 mm 是示例尺度；没有确认真实尺寸时，输出的米制距离也只能按这个假定解释。OpenCV 官方教程同样说明，未知方格尺寸时可使用“一个方格”为长度单位。[OpenCV 标定教程](https://docs.opencv.org/4.x/dc/dbb/tutorial_py_calibration.html)

另外需要图像分辨率：`image.size()` 返回 `Size(width,height)`，顺序为宽、高。

### 2.2 构造棋盘格模型空间中的三维点

把检测顺序中的第一个内角点设为原点，列方向为 $X_O$，行方向为 $Y_O$，所有角点位于 $Z_O=0$ 平面。第 `r` 行、第 `c` 列的角点写成：

$$
P_O=(c\,s,\ r\,s,\ 0),
$$

其中 $s$ 是方格边长。`Point3f` 保存三个浮点数，单位由 $s$ 决定。

```cpp
std::vector<cv::Point3f> board;
// 按行遍历：先完成当前行，再进入下一行，顺序与二维角点对应。
for (int r = 0; r < boardSize.height; ++r)
    for (int c = 0; c < boardSize.width; ++c)
        board.emplace_back(c * squareSize, r * squareSize, 0.0f);
```

边长取 0.025 米时，首行前几个点为 $(0,0,0)$、$(0.025,0,0)$、$(0.05,0,0)$；下一行从 $(0,0.025,0)$ 开始。

棋盘尺寸没有变化，所以不同照片复用同一套模型点。变化的是棋盘相对相机的位姿和照片中的二维像素位置。

标定接口按照片组织数据：

```cpp
std::vector<std::vector<cv::Point3f>> objectPoints;
std::vector<std::vector<cv::Point2f>> imagePoints;
```

外层每个元素是一张照片；内层是该照片的全部角点。`objectPoints[i][j]` 和 `imagePoints[i][j]` 必须对应同一个棋盘角点。`Point2f` 保存像素横坐标和纵坐标，允许小数。

### 2.3 检测并精化二维角点

首先直接读取灰度图，避免额外颜色转换：

```cpp
cv::Mat gray = cv::imread(path, cv::IMREAD_GRAYSCALE);
```

`Mat` 是 OpenCV 的矩阵/图像容器；灰度图每个像素保存一个亮度值。`imread()` 位于 `opencv2/imgcodecs.hpp`。

核心检测接口位于 `opencv2/calib3d.hpp`：

```cpp
bool found = cv::findChessboardCorners(gray, boardSize, corners);
```

- `gray`：输入图像。
- `boardSize`：内角点列数、行数。
- `corners`：输出有序二维角点数组。
- 返回值：是否找到了要求的棋盘。

接着通过 `opencv2/imgproc.hpp` 中的 `cornerSubPix()` 精化角点：

```cpp
cv::cornerSubPix(
    gray, corners, cv::Size(11, 11), cv::Size(-1, -1),
    cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS,
                     30, 0.001));
```

这个函数在角点附近分析灰度变化，直接修改 `corners`，得到更精细的小数像素位置。参数含义是：

- `Size(11,11)`：搜索窗口的半尺寸，完整邻域为 $23\times23$。
- `Size(-1,-1)`：不设置中心排除区。
- `TermCriteria`：终止条件；最多迭代 30 次，或者位置变化达到 0.001 像素的停止阈值。
- 返回形式：没有单独返回角点数组，更新写在原 `corners` 中。

本篇 Demo 忽略检测返回值，建立在全部输入已经检测成功的前提上。完整数据采集程序应另行筛选失败照片。[OpenCV 角点检测与精化流程](https://docs.opencv.org/4.x/dc/dbb/tutorial_py_calibration.html)

### 2.4 调用 `calibrateCamera()` 求参数

完成全部照片的对应点收集后，调用 `opencv2/calib3d.hpp` 中的标定函数：

```cpp
double rms = cv::calibrateCamera(
    objectPoints, imagePoints, imageSize,
    K, D, rvecs, tvecs);
```

| 参数 | 含义 |
|---|---|
| `objectPoints` | 按照片分组的棋盘模型三维点 |
| `imagePoints` | 按照片分组的检测二维角点 |
| `imageSize` | 当前标定图像的宽、高 |
| `K` | 输出内参矩阵，包含像素焦距和主点 |
| `D` | 输出畸变参数 |
| `rvecs` | 每张照片的棋盘旋转向量 |
| `tvecs` | 每张照片的棋盘平移向量 |
| 返回值 `rms` | 全部角点的总体重投影 RMS 误差，单位为像素 |

这里省略了额外选项，使用默认标定模型；不提供已有内参作为初始猜测。`K、D` 可以先声明为空 `Mat`，交由函数分配和求解。

函数内部完成参数初始化和优化，使用者无需再手动计算每张照片的单应矩阵。求得参数后，模型角点经对应照片的位姿、内参和畸变投影，应该接近检测角点。

RMS（Root Mean Square，均方根）将全部点的位置误差平方、求平均再开根号。它用于检查像素拟合质量，无法单独证明物体真实尺寸和测距尺度正确。标定原理及误差解释见第四阶段第 8 节。

### 2.5 保存第二个 Demo 所需的结果

使用 `opencv2/core.hpp` 中的 `FileStorage` 保存参数。它支持 YAML、XML 等结构化文件格式：

```cpp
cv::FileStorage out("camera_params.yml", cv::FileStorage::WRITE);
out << "camera_matrix" << K;
out << "distortion_coefficients" << D;
out.release();
```

`WRITE` 创建或覆盖指定参数文件；`<<` 把名称和对应值写入；`release()` 关闭文件。Demo 使用专门的 `camera_params.yml`，不要把文件名改成需要保留的已有参数文件。

除 $K、D$ 外，还保存图像尺寸、内角点规格和方格边长。第二个程序加载同一份信息，避免重新填参数造成尺度或顺序不一致。

## 3 使用标定结果完成 PnP 和三维投影

### 3.1 准备 PnP 输入

第二个程序使用 `FileStorage::READ` 读取参数，按保存的规格重新构造棋盘模型点，并在一张原始照片上检测、精化角点。

```cpp
cv::FileStorage in("camera_params.yml", cv::FileStorage::READ);
in["camera_matrix"] >> K;
in["distortion_coefficients"] >> D;
```

`in[名称]` 取得文件中的对应字段，`>>` 将它读入变量。

本篇统一使用原始图像上的像素点、原始内参 $K$ 和原始畸变参数 $D$。PnP 本身会在相机模型中考虑畸变，无需先对图像去畸变。若未来改用校正图上的点，应同步使用校正图对应的内参和零畸变定义。

Demo 用 `left01.jpg` 演示，并复用它参与标定的数据；这只能说明调用链能够闭合。检查泛化质量时，应另用同一相机的新照片。

### 3.2 调用 `solvePnP()` 求物体位姿

接口位于 `opencv2/calib3d.hpp`：

```cpp
bool solved = cv::solvePnP(
    board, corners, K, D, rvec, tvec,
    false, cv::SOLVEPNP_ITERATIVE);
```

- `board`：物体空间中的三维角点。
- `corners`：当前照片中的对应像素点。
- `K、D`：已知相机参数。
- `rvec、tvec`：输出当前棋盘的旋转向量和平移向量。
- `false`：不提供已有位姿作为初始猜测。
- `SOLVEPNP_ITERATIVE`：使用迭代求解方式，本篇只采用这一种方式。
- 返回值：求解是否成功，精简 Demo 按成功输入假设省略检查。

这组输出将模型空间中的点变换到相机空间。`tvec` 就是棋盘模型原点在相机空间中的三维位置，长度单位与方格边长一致。[OpenCV PnP 官方说明](https://docs.opencv.org/4.x/d5/d1f/calib3d_solvePnP.html)

### 3.3 求模型点在相机空间中的三维坐标

`rvec` 是旋转向量，其方向表示旋转轴，长度表示旋转角，单位为弧度。通过同一模块中的 `Rodrigues()` 转换成 $3\times3$ 旋转矩阵：

```cpp
cv::Mat R;
cv::Rodrigues(rvec, R);
```

选定一个模型点后，计算：

$$
P_C=R_{CO}P_O+t_{CO}.
$$

例如模型点 $P_O=(s,s,0)^T$ 表示从棋盘原点沿两组板内轴各移动一个方格。使用求出的 $R、t$，便能得到这个现实板点在相机空间中的 $(X_C,Y_C,Z_C)$。

Demo 用 `Mat_<double>(3,1)` 构造三行一列的双精度坐标，保证它与 `R、tvec` 的数据类型一致。`R * point + tvec` 使用矩阵乘法和加法；模型原点 $(0,0,0)^T$ 的计算结果恰好等于 `tvec`。

### 3.4 使用 `projectPoints()` 完成重投影

同一模块中的 `projectPoints()` 将模型点经位姿和相机模型转换成像素点：

```cpp
cv::projectPoints(board, rvec, tvec, K, D, reprojection);
```

前五个输入分别是模型三维点、旋转、平移、内参和畸变；`reprojection` 是输出的二维点数组，与 `board` 保持相同顺序。函数直接写入输出数组。

设检测像素为 $p_i$、重投影像素为 $\hat p_i$，共有 $N$ 点，误差为：

$$
\mathrm{RMS}=\sqrt{\frac{1}{N}\sum_{i=1}^{N}\lVert p_i-\hat p_i\rVert^2}.
$$

代码中的 `norm(corners,reprojection,NORM_L2)` 计算所有坐标差平方和的平方根，再除以 $\sqrt{N}$ 就得到上述 RMS。这里按“每个二维点”为单位，分母是点数 $N$。

### 3.5 定义并投影立方体八个顶点

立方体是人工定义的虚拟模型，不需要在照片中实际存在。它和棋盘使用同一个物体坐标系，所以可以复用棋盘的 $R、t$。

设立方体边长为 $a=2s$，其中 $s$ 为方格边长。底面位于棋盘平面，八点定义为：

| 编号 | 模型空间坐标 | 说明 |
|---|---|---|
| 0 | $(0,0,0)$ | 底面原点 |
| 1 | $(a,0,0)$ | 底面沿 $X_O$ 方向 |
| 2 | $(a,a,0)$ | 底面沿两组轴移动 |
| 3 | $(0,a,0)$ | 底面沿 $Y_O$ 方向 |
| 4 | $(0,0,-a)$ | 0 号点对应的顶面点 |
| 5 | $(a,0,-a)$ | 1 号点对应的顶面点 |
| 6 | $(a,a,-a)$ | 2 号点对应的顶面点 |
| 7 | $(0,a,-a)$ | 3 号点对应的顶面点 |

边长取 0.025 米时，$a=0.05$ 米。顶面沿物体空间的 $-Z_O$ 放置，这是这里选择的模型方向。$+Z_O$ 的朝向由 $X_O、Y_O$ 和右手坐标约定共同确定；不能脱离角点排序声称正负 Z 总是朝向相机。这里的负模型 Z 也不意味着顶点位于相机后方，相机空间坐标仍要经过 $R、t$ 求得。

把八个顶点交给 `projectPoints()` 得到八个像素坐标；逐点使用 $RP_O+t$ 则得到八个相机空间坐标。前者回答“模型点落在哪个像素”，后者回答“模型点在相机前方哪里”。本篇只输出这些数值，不连接边线或绘制立方体。

## 4 两个最小 C++ Demo

两个程序各有独立 `main()`，按顺序运行。依赖 OpenCV 的 `core、imgproc、imgcodecs、calib3d` 模块，图片放在运行目录的 `data/` 下，参数文件写到运行目录。

### 4.1 Demo 1：相机标定

保存为 `calibrate_min.cpp`。输入是下列 13 张预先确认检测成功的照片；输出是 `camera_params.yml` 和控制台中的 $K、D$、RMS。

```cpp
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/calib3d.hpp>
#include <iostream>
#include <string>
#include <vector>

int main()
{
    // 指定每行内角点数和行数；方格边长使用米制示例尺度。
    const cv::Size boardSize(9, 6);
    const float squareSize = 0.025f;

    // 指定输入照片，假定所有照片规格一致、角点均可检测成功。
    const std::vector<std::string> files = {
        "data/left01.jpg", "data/left02.jpg", "data/left03.jpg",
        "data/left04.jpg", "data/left05.jpg", "data/left06.jpg",
        "data/left07.jpg", "data/left08.jpg", "data/left09.jpg",
        "data/left11.jpg", "data/left12.jpg", "data/left13.jpg",
        "data/left14.jpg"
    };

    // 按行构造棋盘模型点：列方向为 X，行方向为 Y，板面 Z 为 0。
    std::vector<cv::Point3f> board;
    for (int r = 0; r < boardSize.height; ++r)
        for (int c = 0; c < boardSize.width; ++c)
            board.emplace_back(c * squareSize, r * squareSize, 0.0f);

    // 外层按照片分组，内层保存该照片中的全部对应角点。
    std::vector<std::vector<cv::Point3f>> objectPoints;
    std::vector<std::vector<cv::Point2f>> imagePoints;
    cv::Size imageSize;

    // 为每张照片建立一组模型点与像素点的对应关系。
    for (const auto& file : files)
    {
        // 直接读取灰度图，并记录当前图像尺寸。
        cv::Mat gray = cv::imread(file, cv::IMREAD_GRAYSCALE);
        imageSize = gray.size();

        // 检测有序的二维内角点，按成功输入前提省略返回值检查。
        std::vector<cv::Point2f> corners;
        cv::findChessboardCorners(gray, boardSize, corners);

        // 在角点附近精化坐标，直接更新 corners 中的小数像素位置。
        cv::cornerSubPix(gray, corners, cv::Size(11, 11), cv::Size(-1, -1),
            cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS,
                             30, 0.001));

        // 将当前照片的三维模型点和二维检测点按相同序号追加。
        objectPoints.push_back(board);
        imagePoints.push_back(corners);
    }

    // 联合全部照片求内参、畸变及各照片位姿，返回总体像素 RMS。
    cv::Mat K, D;
    std::vector<cv::Mat> rvecs, tvecs;
    double rms = cv::calibrateCamera(objectPoints, imagePoints, imageSize,
                                    K, D, rvecs, tvecs);

    // 创建或覆盖专用参数文件，供第二个程序读取。
    cv::FileStorage out("camera_params.yml", cv::FileStorage::WRITE);
    out << "camera_matrix" << K << "distortion_coefficients" << D;
    out << "image_width" << imageSize.width << "image_height" << imageSize.height;
    out << "board_width" << boardSize.width << "board_height" << boardSize.height;
    out << "square_size" << squareSize;
    out.release();

    // 输出核心标定结果；误差单位为像素。
    std::cout << "K:\n" << K << "\nD:\n" << D << "\nRMS: " << rms << '\n';
    return 0;
}
```

Linux 上已经安装 OpenCV 开发库且提供 `opencv4.pc` 时，编译运行：

```bash
g++ -std=c++17 calibrate_min.cpp -o calibrate_min $(pkg-config --cflags --libs opencv4)
./calibrate_min
```

程序先收集对应点，再进行一次整体标定，最后保存相机参数。数值会随输入照片和检测结果变化，不预设固定的误差合格线。

### 4.2 Demo 2：PnP、重投影与立方体投影

保存为 `pnp_project_min.cpp`。先运行 Demo 1，输入其参数文件和 `data/left01.jpg`。输出是棋盘原点位置、重投影 RMS，以及立方体八点的相机坐标和像素坐标。

```cpp
#include <opencv2/core.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <opencv2/calib3d.hpp>
#include <cmath>
#include <iostream>
#include <vector>

int main()
{
    // 读取上一程序输出的相机参数和棋盘模型规格。
    cv::FileStorage in("camera_params.yml", cv::FileStorage::READ);
    cv::Mat K, D;
    int boardWidth, boardHeight;
    float squareSize;
    in["camera_matrix"] >> K;
    in["distortion_coefficients"] >> D;
    in["board_width"] >> boardWidth;
    in["board_height"] >> boardHeight;
    in["square_size"] >> squareSize;
    in.release();

    // 用完全相同的尺度和顺序重新构造棋盘模型点。
    const cv::Size boardSize(boardWidth, boardHeight);
    std::vector<cv::Point3f> board;
    for (int r = 0; r < boardSize.height; ++r)
        for (int c = 0; c < boardSize.width; ++c)
            board.emplace_back(c * squareSize, r * squareSize, 0.0f);

    // 读取原始灰度照片，假定成像模式与标定时一致。
    cv::Mat gray = cv::imread("data/left01.jpg", cv::IMREAD_GRAYSCALE);

    // 检测当前照片中的棋盘角点。
    std::vector<cv::Point2f> corners;
    cv::findChessboardCorners(gray, boardSize, corners);

    // 精化二维角点坐标，保持与 board 相同的角点顺序。
    cv::cornerSubPix(gray, corners, cv::Size(11, 11), cv::Size(-1, -1),
        cv::TermCriteria(cv::TermCriteria::COUNT | cv::TermCriteria::EPS,
                         30, 0.001));

    // 求当前棋盘到相机的位姿：tvec 为模型原点的相机空间位置。
    cv::Mat rvec, tvec;
    cv::solvePnP(board, corners, K, D, rvec, tvec,
                 false, cv::SOLVEPNP_ITERATIVE);

    // 把旋转向量转为双精度旋转矩阵，后续用于三维坐标变换。
    cv::Mat R;
    cv::Rodrigues(rvec, R);

    // 将棋盘模型点投回原图像素坐标，得到与 corners 对应的预测点。
    std::vector<cv::Point2f> reprojection;
    cv::projectPoints(board, rvec, tvec, K, D, reprojection);

    // 对全部二维点计算像素 RMS，不进行绘制或显示。
    double rms = cv::norm(corners, reprojection, cv::NORM_L2)
                 / std::sqrt(static_cast<double>(corners.size()));

    // 定义边长为两个方格的虚拟立方体：底面 Z=0，顶面 Z=-a。
    const float a = 2.0f * squareSize;
    const std::vector<cv::Point3f> cube = {
        {0, 0, 0}, {a, 0, 0}, {a, a, 0}, {0, a, 0},
        {0, 0, -a}, {a, 0, -a}, {a, a, -a}, {0, a, -a}
    };

    // 用棋盘位姿投影八个模型顶点，输出顺序与 cube 一致。
    std::vector<cv::Point2f> cubePixels;
    cv::projectPoints(cube, rvec, tvec, K, D, cubePixels);

    // 输出模型原点的三维位置和当前照片的重投影误差。
    std::cout << "Origin in camera:\n" << tvec << "\nRMS: " << rms << '\n';

    // 逐点计算相机空间 XYZ，并输出同一点的像素位置。
    for (std::size_t i = 0; i < cube.size(); ++i)
    {
        // 将模型坐标组成双精度 3×1 列向量，与 R 和 tvec 类型一致。
        cv::Mat pointO = (cv::Mat_<double>(3, 1)
                          << cube[i].x, cube[i].y, cube[i].z);

        // 从模型空间变到相机空间；单位沿用 squareSize 的米制尺度。
        cv::Mat pointC = R * pointO + tvec;

        // 输出顶点编号、相机坐标 XYZ 和投影像素 u、v。
        std::cout << i << " XYZ: " << pointC.t()
                  << " pixel: " << cubePixels[i] << '\n';
    }
    return 0;
}
```

编译运行：

```bash
g++ -std=c++17 pnp_project_min.cpp -o pnp_project_min $(pkg-config --cflags --libs opencv4)
./pnp_project_min
```

0 号顶点的模型坐标是原点，所以它的相机坐标等于 `tvec`。其他顶点分别经过相同的旋转和平移；对应的 `cubePixels[i]` 是该顶点按相机模型得到的二维投影。

Windows / Visual Studio 中，分别创建两个控制台目标，配置 OpenCV 头文件、库和对应运行时 DLL；可链接发行包的 `opencv_world`，或前文列出的四个模块。运行工作目录放置 `data/` 和 `camera_params.yml`，程序不依赖参考代码中的 Windows 中文绘制或自定义头文件。
