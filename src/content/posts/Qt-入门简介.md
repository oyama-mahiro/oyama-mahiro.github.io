---
title: "[Qt] 入门简介"
published: 2023-05-04
tags: [Qt, QML, C++]
category: Qt
draft: false
---

# [Qt] 入门简介

这篇按 Qt 6 来写。界面用 Qt Quick 和 QML。Widgets 和 `.ui` 仍然能做传统桌面窗口，但不是这条路的中心。读的时候先弄清一个名字指什么、它活在哪条线程上、QML 看见的是它的哪一面，再写调用。

大纲分三块。每一块里，点名的机制都在，旁边那些不讲就无法动手的部分也在。

1. Qt 本身。库在管什么；CMake 工程里 moc 和 QML 模块是什么；元对象；`QObject` 的父子、所有权和线程归属；属性；信号与槽怎样连接、跨线程时谁执行槽；事件和事件循环的差别；`QThread` 的 `run` 与 `exec`；Widgets 怎样画，以及 QML 换成 `QQuickItem` 和场景图之后怎样画；常用模块各自负责哪一段。
2. QML。语言在描述什么；一份文档怎样变成对象；内存上的对象树和视觉上的父子为什么不是同一棵；组件、模块 URI、C++ 类型怎样注册进去；元素之间用绑定、信号、属性别名和单例通信；Quick 的基本项、控件、鼠标与键盘、列表、状态动画；Quick 3D 在同一窗口里占哪一块。
3. 两侧怎么接。先说明这道边界为什么窄；再按需求分类：QML 使用 C++ 的函数和数据，C++ 使用 QML 的输入和界面动作，两边读写同一份数据，以及 C++ 提供一块像素并放进 QML 的布局。每一类写它自己的规则，而不是把接口名排成一张清单。

渲染链在 1.9 节建立整体地图，3.6 节说明怎样选择和实现自定义绘制，3.7 节再把 NV12 代入作为完整例子；其余基础仍按上面的顺序学习。

## 一、Qt 本身

### 1.1 它是什么

Qt 是一套 C++ 库，加上在编译时生成代码的工具。界面只是它的一块。后面无论写按钮还是自己的绘制，都会碰到同一套底座：对象树、元对象、事件循环、信号与槽、线程归属。QML 里看见的矩形，运行时多半仍是这些 C++ 对象。

Qt 6 做界面有两条路。

Widgets 用 C++ 的 `QWidget` 树描述窗口。每个控件在自己的 `paintEvent` 里画。可选的 `.ui` 文件是这份树的 XML，由 uic 转成 C++。适合已经大量使用控件、并且不需要场景图动画的桌面程序。

Qt Quick 用 QML 描述界面。可见项是 `QQuickItem`。真正提交给显卡的是另一棵场景图，通常在渲染线程里画。动画、手势、和后来要嵌进去的自绘，都走这条路。这篇以 Quick 为主。需要一块自己的绘制时，写一个 Quick 项放进 QML 树，而不是再弹一个 Widgets 窗口盖在上面。

两条路共用 `QObject`、信号槽和事件循环。选 Quick 不是换掉这套底座，只是换掉“谁来画像素”。

Python 的 PySide 调用的仍是这些库，对象模型没有第二套。学的时候以 C++ 和 QML 为准。

### 1.2 工程里每个文件在干什么

新工程用 CMake，不手写 Makefile，也不再把 `.pro` 当作默认入口。qmake 还能编旧工程。新代码用 Qt 提供的 CMake 宏，由它们去调 moc、资源编译和 QML 类型注册。

一个能显示 QML 的最小工程里，通常有这些东西：

- `CMakeLists.txt`：声明可执行文件、Qt 组件、QML 模块的 URI 和版本。
- `main.cpp`：创建应用对象和 QML 引擎，加载模块里的根组件，进入事件循环。
- 若干 `.h` / `.cpp`：业务对象。要被 QML 看见的类在头文件里标记。
- 若干 `.qml`：界面文档。
- 图片、着色器：放进同一模块，QML 用相对模块的 URL 引用。

```cmake
cmake_minimum_required(VERSION 3.16)
project(myapp LANGUAGES CXX)
find_package(Qt6 REQUIRED COMPONENTS Quick)
qt_standard_project_setup(REQUIRES 6.5)
qt_add_executable(myapp main.cpp)
qt_add_qml_module(myapp
    URI MyApp
    VERSION 1.0
    QML_FILES Main.qml
    SOURCES backend.h backend.cpp
)
target_link_libraries(myapp PRIVATE Qt6::Quick)
```

`URI MyApp` 就是 QML 里 `import MyApp` 的那个名字。版本要对上。`QML_FILES` 里的 `Main.qml` 定义类型 `Main`。`SOURCES` 里的 C++ 类型如果写了 `QML_ELEMENT`，会注册进同一个模块。漏掉 `SOURCES`，QML 里写这个类名会报类型不存在。

```cpp
#include <QGuiApplication>
#include <QQmlApplicationEngine>

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QQmlApplicationEngine engine;
    QObject::connect(
        &engine, &QQmlApplicationEngine::objectCreationFailed,
        &app, []() { QCoreApplication::exit(-1); },
        Qt::QueuedConnection);
    engine.loadFromModule("MyApp", "Main");
    return app.exec();
}
```

`QGuiApplication` 是不使用 Widgets 时的应用对象。它持有和窗口系统的连接。`QQmlApplicationEngine` 是能加载模块、并且在根对象创建失败时发出信号的引擎。`loadFromModule` 按 URI 找类型，不写一个磁盘上的 `main.qml` 绝对路径。`exec` 进入事件循环。没有这行，`main` 立刻返回，窗口来不及显示。

加载失败时看程序在控制台打出的 QML 警告，里面有文件和行号。`objectCreationFailed` 用来让进程退出，避免一个空白窗口被当成“已经跑起来了”。

### 1.3 元对象和 moc

C++ 本身没有“这个对象有哪些信号、哪些属性”的运行时表。Qt 用 moc 在编译前读头文件，生成另一份 C++。生成物里有元对象：类名、父类、信号、槽、属性、枚举。`QObject::connect` 的旧式字符串写法、QML 读写属性、`QMetaObject::invokeMethod`，都查这张表。

要生成这张表，类必须继承 `QObject`（或带 `Q_GADGET` 的值类型，值类型没有信号），并且在私有区开头写 `Q_OBJECT`。写了宏却忘了让构建系统处理这个头文件时，链接会报元对象的符号找不到。`qt_add_executable` 和 `qt_add_qml_module` 会扫描源文件列表，所以类的头文件和源文件都要出现在 CMake 里。

没有 `Q_OBJECT` 的类仍然是 C++ 类。它可以有普通成员函数。它没有信号，QML 也不能把它的成员当成属性绑定。

### 1.4 QObject：父子、删除、线程

`QObject` 是这套模型的公共基类。三件事跟着它走：父对象、线程归属、元对象。

父对象形成一棵所有权树。构造时把 `parent` 传进去，或之后 `setParent`。父对象析构时，按子对象列表把它们删除。窗口关了，里面创建时指定了这个窗口为父对象的定时器、辅助对象会一起走。已经交给父对象的指针，不要再自己 `delete`。要在当前函数栈上的对象还在被使用时推迟删除，调用 `deleteLater`。它往对象所属线程的事件循环投递一个删除事件，等这次调用返回后再删。

```cpp
auto *clock = new Clock(window);
clock->deleteLater();
```

这里 `window` 是父对象。若在 `deleteLater` 之前 `window` 已经析构，`clock` 已经被父对象删掉，不能再对它调用任何函数。

每个对象记住创建它的线程，称为线程归属。定时器在这根线程的事件循环里触发。队列连接把槽投递到接收者所属的线程。对象有父对象时不能 `moveToThread`。要挪到工作线程，创建时父对象必须是空的，然后在工作线程启动后移进去。子对象不会自动换线程。

GUI 上的 `QQuickItem` 和给 QML 调用的业务对象，留在 GUI 线程。工作线程只做计算，做完发信号。槽如果连到 GUI 对象上，跨线程时会排队，等 GUI 的事件循环执行。这样属性在 GUI 线程上改，QML 绑定也在 GUI 线程上重算。

### 1.5 属性

属性是一对约定：怎么读、怎么改、改了通知谁。C++ 成员变量没有这条约定，QML 的绑定无法订阅一个裸的 `int`。

```cpp
class Clock : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QString text READ text WRITE setText NOTIFY textChanged)
public:
    explicit Clock(QObject *parent = nullptr) : QObject(parent) {}

    QString text() const { return m_text; }

    void setText(const QString &text)
    {
        if (m_text == text)
            return;
        m_text = text;
        emit textChanged();
    }

signals:
    void textChanged();

private:
    QString m_text;
};
```

`READ` 必须有。`WRITE` 可以没有，那就是只读属性，QML 不能赋值。`NOTIFY` 是一个信号，在值真正变化时发出。QML 里 `text: clock.text` 依赖的就是这个信号。`setText` 里如果值没变也发信号，绑定会无意义地重算。值变了却不发信号，界面停在旧值，C++ 里看变量已经是新的。

`WRITE` 里先比较再赋值，是为了切断“赋值又发信号、信号又导致再赋值”的环。比较用类型自己的相等，字符串用 `QString` 的比较，不要用指针地址比较两份文本。

`objectName` 是 `QObject` 自带的一个字符串属性，给 `findChild` 和调试用。QML 的 `id` 不是它。`id` 只在那一份 QML 文档的作用域里存在，不会变成 C++ 能搜到的对象名，除非你自己把 `objectName` 设成同一个字符串。

### 1.6 信号与槽

信号表示发生了一件事。槽是这件事发生时要调用的函数。两边用 `connect` 接上之后，发送者不必保存接收者的指针。接收者销毁时，它身上的连接会卸掉。这是 `QObject` 提供的，普通 C++ 对象做不到。

Qt 5 以后优先写成成员函数指针。参数类型不对时编译失败，而不是运行到那一次才发现：

```cpp
connect(clock, &Clock::textChanged, this, &Window::updateCaption);
```

也可以连到 lambda。lambda 如果要用到 `this`，把 `this` 作为上下文对象传进去，这样 `this` 销毁时连接一起断：

```cpp
connect(clock, &Clock::textChanged, this, [this] {
    setWindowTitle(clockText());
});
```

`emit textChanged()` 在 C++ 里就是一次函数调用。moc 生成的信号函数会按连接类型决定怎么办。同一个线程上的直接连接，槽在 `emit` 的栈上立刻执行。接收者在另一条线程时，默认变成队列连接：参数被打包放进接收者线程的事件队列，等那条线程的 `exec` 取出再调用槽。所以工作线程如果没有事件循环，别人排队给它的槽不会跑。GUI 线程若卡在你的槽里不返回，队列里后面的绘制、输入和别的槽都等着。

一个信号可以连很多槽。槽也可以是另一个信号，等于把事件转发出去。连接可以用 `disconnect` 拆掉。在 `setText` 里暂时不想让外面的槽把值又写回来，可以用 `QSignalBlocker` 挡住这个对象发出的信号，离开作用域后恢复。

槽里允许再 `emit`。那仍然是同步的调用链，不是新开了一条线程。链太深，或槽里又同步等待另一个会回到本线程的操作，就会卡住或死锁。耗时工作放到别的线程，完成时发一个只携带结果的信号。

参数按值或按 const 引用放进信号都可以。队列连接时，参数会被复制进事件。自定义类型要能复制，并且用 `Q_DECLARE_METATYPE` 让元对象系统认识它，队列连接才知道怎样拷贝。注册过的 `QObject` 指针可以放进信号，但接收者执行时要允许这个对象已经不存在，所以更稳妥的是传一份值，或在槽里检查指针。

### 1.7 事件和事件循环

`app.exec()` 之后，线程停在循环里，反复做三件事：从窗口系统取输入和必须处理的系统消息；取出 `postEvent` 放进队列的 `QEvent`；执行到期的定时器、`deleteLater` 和排队的槽。`quit` 或主窗口约定的退出会让 `exec` 返回。

事件和信号是两层。鼠标按下先到窗口，成为事件。Quick 的窗口在 GUI 线程处理这个事件，命中哪个 `Item`，再让指针处理器或 `MouseArea` 发出它们自己的信号。业务代码若只关心“按钮被点了”，连接信号即可。若要在控件还没解释这次点击之前拿走它，才在事件这一层做过滤器。

```cpp
class Filter : public QObject
{
public:
    using QObject::QObject;
protected:
    bool eventFilter(QObject *watched, QEvent *event) override
    {
        if (event->type() == QEvent::KeyPress)
            return true;
        return QObject::eventFilter(watched, event);
    }
};
```

返回 `true` 表示这次事件已经处理，不再往下传。过滤器对象本身也要活得比被监视对象久，或在析构前卸掉，否则会过滤一个已经销毁的监视关系。

`QTimer` 的超时是事件循环上的一项，不是一条独立的硬件中断。`singleShot(0, ...)` 表示当前函数返回、循环再转一圈时执行。用来等对象树建完再做依赖子对象的事。在槽里写一个 `while` 不返回，定时器不会插进来。不要用 `processEvents` 在槽中间刷新界面。它会重入：另一次输入可能在你这趟函数还没写完成员时进来，改同一份数据。

主线程的 `exec` 是 `QGuiApplication::exec` 或 `QApplication::exec`。另一条线程上的循环是 `QThread` 自己的事，在下一节单独说。渲染也不是这条线程本身，放在线程之后再讲。

### 1.8 QThread

`QThread` 是 Qt 用来管理一条操作系统线程的 `QObject`。它自己通常还留在创建它的那条线程上，多半是 GUI 线程。`start()` 之后，操作系统才跑起来一条新线程，并在那条新线程里调用这个对象的 `run()`。

默认的 `run()` 只有一件事：调用 `exec()`。`exec()` 在这条新线程上进入事件循环，和主线程的 `app.exec()` 是同一类循环，只是队列分开。这条循环在跑，排队到这根线程的槽、`QTimer`、`deleteLater` 才会执行。有人调用 `quit()`，循环返回，`run()` 结束，线程退出。

```cpp
QThread thread;
thread.start();
```

这里没有重写 `run()`，所以新线程里就是 `exec()`。循环空转着，直到 `quit()`。

重写了 `run()` 之后，默认的 `exec()` 不会再被调用。函数里若只是算完一段数据就返回，这条线程没有事件循环，也不需要。函数里若还要让这个线程上的 `QObject` 接收队列信号或使用定时器，就要自己把循环跑起来：

```cpp
class WorkerThread : public QThread
{
protected:
    void run() override
    {
        exec();
    }
};
```

只重写 `run()`、里面不调用 `exec()`，又把一个对象 `moveToThread` 到这条线程上，对象的槽不会被投递执行。线程已经在跑你的 `run()`，没有人在取事件队列。

更常见的写法是不重写 `run()`，让默认的 `exec()` 留着。把真正的工作做成一个没有父对象的 `QObject`，挪到这条线程上。`QThread` 对象仍然在 GUI 线程，工作者对象的线程归属才是新线程。

```cpp
class Worker : public QObject
{
    Q_OBJECT
public slots:
    void doWork() { emit finished(); }
signals:
    void finished();
};

QThread thread;
auto *worker = new Worker;
worker->moveToThread(&thread);
QObject::connect(&thread, &QThread::started, worker, &Worker::doWork);
QObject::connect(worker, &Worker::finished, &thread, &QThread::quit);
QObject::connect(&thread, &QThread::finished, worker, &QObject::deleteLater);
thread.start();
```

`started` 在新线程的循环里发出，所以 `doWork` 也在新线程执行。`finished` 连到 `quit`，用来结束 `exec()`。工作者不能有父对象，否则 `moveToThread` 会失败。

`QThread` 不是渲染器，也不是一条专门用来画界面的线程。界面控件和 QML 项仍然留在 GUI 线程。这条线程只是第二份事件循环，用来做不该堵住 `app.exec()` 的工作。

### 1.9 渲染：界面状态怎样变成屏幕上的像素

先把“有一个可见对象”和“这一帧已经画到屏幕”分开。GUI 线程里的对象保存位置、大小、颜色和输入状态；绘制系统根据这些状态生成可渲染的数据；图形后端执行绘制；最后窗口系统呈现结果。`update()` 只请求后续更新，不会在当前函数里立刻运行片元着色器。

Widgets 和 Qt Quick 走的是两条不同的绘制链：

|  | Widgets | Qt Quick / QML |
| --- | --- | --- |
| 可见对象 | `QWidget` | `QQuickItem` |
| 自定义内容入口 | `paintEvent()` 中使用 `QPainter` | `ShaderEffect`、`updatePaintNode()`、`QQuickRhiItem` 等 |
| 绘制表示 | 控件画到窗口的 backing store | 项状态同步到场景图节点，或由项提供离屏输出纹理 |
| QML 布局、遮挡 | 不属于 Widgets 自身 | 项可使用 anchors、布局、`z`、裁剪和透明度 |

Widgets 一侧的流程是：数据改变后调用 `update()`；事件循环稍后派发绘制事件；控件的 `paintEvent()` 用 `QPainter` 更新缓冲；Qt 再把缓冲交给窗口系统。这里的重点是“控件自己负责怎样画”。`repaint()` 会尝试立即绘制，容易在未完成的数据修改中重入，一般使用 `update()`。

Qt Quick 一侧先有 **QML/QQuickItem 对象树**。`Item`、`Rectangle`、`Text`、`Image` 和你注册的自定义项都在这棵树里。它决定“对象是什么、放在哪、与谁一起布局”；普通 `Item` 可以只是容器，本身没有像素。窗口对应 `QQuickWindow`，它还管理另一棵用于绘制的**场景图**。场景图的 `QSGNode` 保存足以画这一帧的几何、纹理、材质、变换和裁剪。它不是另一份 QML 文档，QML 的 `id` 也不能拿来访问 `QSGNode`。[Qt：场景图概念](https://doc.qt.io/qt-6/qtquick-visualcanvas-scenegraph.html)

一次 Qt Quick 帧更新可以按四个时刻理解：

```text
① GUI：输入、信号或绑定改变 QQuickItem 的属性；需要自绘的项调用 update()
② 同步：Qt Quick 把改变的项状态交给场景图节点或自定义渲染器
③ 绘制：图形后端执行几何、纹理与着色器对应的 GPU 命令
④ 呈现：Qt Quick 把各项结果合成到窗口，窗口系统显示这一帧
```

采用线程化渲染循环时，同步阶段 GUI 线程短暂停住，渲染线程读取一份稳定的项状态；之后 GUI 可继续处理事件，渲染线程使用已同步的数据画这一帧。有些平台使用单线程渲染循环，自定义代码仍应遵守同样的交接规则。**QQuickItem 的属性在 GUI 线程修改；QSG 节点和 QRhi 资源在对应渲染阶段处理。**如果 GUI 槽一直阻塞，输入和下一次同步都排不上来，所以“画面不更新”未必是 shader 错了。[Qt：渲染循环](https://doc.qt.io/qt-6/qtquick-visualcanvas-scenegraph.html)

Qt 6 的 Qt Quick 可经 OpenGL、Vulkan、Metal 或 Direct3D 等图形后端绘制。RHI（Rendering Hardware Interface）是 Qt 用来组织纹理、顶点缓冲、图形管线和命令的抽象层。普通 `Rectangle` 或 `Image` 不要求你直接操作 RHI；只有选择更底层的自定义入口时才会接触这些资源。着色器属于第③步的像素或顶点计算，它不能直接从一块未经上传的 CPU 内存读取 NV12 数据。[Qt：QQuickRhiItem](https://doc.qt.io/qt-6/qquickrhiitem.html)

因此，“把结果显示在 QML 上”并不是每帧把一个 RGB 数组赋给 QML。常见做法是**提供一个 QML 可布局的项**：让它交出场景图几何与材质，或先在离屏颜色纹理中生成画面，再由 Qt Quick 把该纹理作为项的内容合成。此后按钮和文字仍是普通 Quick 项，位置、遮挡和 `z` 由 QML 决定。具体怎样自己提供内容，在 3.6 节接着讲。

### 1.10 模块各自管哪一段

C++ 链接的是 Qt 的库，QML `import` 的是模块。两边名字不完全相同。

| 要做的事 | C++ 组件 | QML 里常见的 import |
| --- | --- | --- |
| 对象、线程、文件、定时器 | Core | 不直接画界面 |
| 图像、窗口、键鼠事件、RHI | Gui | 被 Quick 使用 |
| 引擎、类型注册、绑定 | Qml | `QtQml` |
| 可见项、场景图、动画、手势 | Quick | `QtQuick` |
| 按钮、输入框、弹窗 | Quick Controls | `QtQuick.Controls` |
| 行、列、网格 | Quick Layouts | `QtQuick.Layouts` |
| 同一窗口里的三维 | Quick 3D | `QtQuick3D` |
| 着色器编成多后端 | Shader Tools | 构建时处理，QML 引用产物 |
| 网络、数据库、音视频 | Network、Sql、Multimedia | 对应的 QML 模块或只在 C++ 用 |

登录页通常是 Core、Qml、Quick、Controls。自绘几何再使用 Gui 里的场景图类型。三维模型再加 Quick 3D。显示一个矩形不必链接 Widgets。

## 二、QML

### 2.1 这份文件在描述什么

QML 描述一棵对象树，并给对象的属性写下绑定。它不是另一门用来替代 C++ 的通用语言。文件顶部的 `import` 决定哪些类型名可用。`Rectangle` 来自 `QtQuick`，不是关键字。没导入模块就写这个名字，报的是类型找不到。

引擎把文档编译成一份可以反复实例化的组件。`loadFromModule` 实例化根组件一次，成为窗口。列表的委托、`Loader`、`Repeater` 会再实例化许多次。同一份 `Row.qml` 在列表里有一百个对象，它们的属性互不影响。

属性绑定和普通赋值不同。

```qml
Rectangle {
    width: parent.width / 2
    height: 40
    color: mouse.containsPress ? "steelblue" : "gray"
}
```

`width` 会在 `parent.width` 变化时重算。这不是创建时抄一次数字。若改成 `Component.onCompleted: width = parent.width / 2`，那是一次赋值，之后父项变宽，矩形不会跟着走。需要永远跟着数据时用绑定。需要用户拖过之后保持拖动结果时，在信号里赋值，并接受它切断原来的绑定。

JavaScript 可以写在信号处理器里，适合几行分支。循环遍历大数组、读文件、访问设备，放在 C++ 里，QML 只调用函数并显示返回的属性。

### 2.2 对象是怎样建出来的

加载一份文档时，引擎按嵌套顺序创建对象。外层对象先分配，再创建子对象，子对象的绑定可以引用父对象。全部子树准备好之后，才发出 `Component.onCompleted`。在绑定表达式里调用一个依赖“所有子项已经在”的函数，经常会早于完成通知。这种逻辑放进 `onCompleted`，或放进子项自己的完成处理里。

`Loader` 把另一个组件推迟到需要时再创建，适合页面切换。`active` 变成 false 时，里面的对象会销毁。不要把只有加载器里才存在的对象的 `id` 拿给外面长期保存。`Repeater` 和 `ListView` 的委托同理：委托的 `id` 在外面不可见，行与行之间用模型数据区分。

动态创建还可以 `Qt.createComponent("Dialog.qml").createObject(parentItem, { title: "设置" })`。第二个参数是初始属性。第一个参数是父对象。不传父对象时，这份对象由 JavaScript 所有，没有变量再指向它时可以被回收，屏幕上的项会消失。动态窗口若要一直留着，把它的父对象设成已经在树上的项，或放进一个你持有的 `Loader`。

### 2.3 两棵树：谁删除它，画在谁里面

QML 对象几乎都是 `QObject`。文档里的缩进通常让外层成为内层的 `QObject` 父对象。父对象销毁，子对象一起销毁。这是内存上的树。

`Item` 还有视觉父子，属性名就叫 `parent`。坐标、裁剪、绘制先后按视觉父节点。很多时候两棵树是同一个对象。一旦用了加载器、重复器、或者 C++ 里指定了另一个 `QObject` 父对象，两者就分开。查泄漏时看 `QObject` 父对象。查“为什么画到了屏幕外面”时看视觉 `parent` 和坐标映射 `mapToItem`。

```qml
Item {
    id: page
    Loader {
        id: slot
        sourceComponent: inner
    }
    Component {
        id: inner
        Rectangle { width: 10; height: 10 }
    }
}
```

加载出来的矩形，视觉上要出现在哪，由 `Loader` 在场景中的位置决定。它的创建者是加载器，不是 `page` 下面手写的那个矩形。不要假设 `page.children` 里一定能数到动态创建的每一项。

所有权还有一层：引擎认为对象归 JavaScript 还是归 C++。文档里写出来的对象，默认可以由引擎在没有引用时回收，但只要还在 `QObject` 树上，父对象就留着它。C++ `new` 出来再交给 QML 的对象，若 C++ 还要 `delete`，用 `QQmlEngine::setObjectOwnership(..., CppOwnership)`，或者给它一个会负责删除的 C++ 父对象。两边都认为自己该删，程序会在退出或翻页时崩溃。

`id` 只在当前这份文档里有效。另一个文件要使用这个对象，通过属性传进去，或使用注册过的单例。字符串 `objectName` 不能代替 `id`。

### 2.4 模块和类型注册

QML 里能写出来的类型名，都必须属于某个已加载的模块。否则引擎只认识语言本身，不认识 `Button` 或你的 `Backend`。

QML 文件成为类型：文件名就是类型名，`Button.qml` 是 `Button`。它要列在 `qt_add_qml_module` 的 `QML_FILES` 里。宏会生成 `qmldir`，里面写着 URI、版本和文件。别的文件 `import` 这个 URI 后使用它。文件放在磁盘上但没进模块，`import` 仍然找不到。

C++ 类成为类型：类继承 `QObject`，头文件有 `Q_OBJECT` 和 `QML_ELEMENT`，源文件列在模块的 `SOURCES` 里。构建系统生成注册代码，和手写 `qmlRegisterType` 二选一。两边都注册同一个类，会得到重复注册的警告，QML 里的名字也不稳定。

```cpp
class Backend : public QObject
{
    Q_OBJECT
    QML_ELEMENT
public:
    explicit Backend(QObject *parent = nullptr);
};
```

需要换一个 QML 名字时用 `QML_NAMED_ELEMENT(AppBackend)`。整个进程只该有一份时用 `QML_SINGLETON`，并提供静态的创建函数。不允许在 QML 里写出这个类型的实例时，用 `QML_UNCREATABLE("由 C++ 创建")`，把原因写进字符串，方便报错信息被人看懂。

```qml
import QtQuick
import QtQuick.Controls
import MyApp

Window {
    width: 360
    height: 240
    visible: true
    Backend { id: backend }
}
```

`import MyApp` 的名字和 CMake 的 `URI` 一致，版本不高于模块声明的版本。报 `module is not installed` 时，先核对 URI、可执行文件有没有链接这个模块、以及运行目录是不是构建目录。那不是矩形颜色的问题。

单例在 QML 里用 `pragma Singleton` 配一份 `.qml`，或在 C++ 里用 `QML_SINGLETON`。适合主题、连接状态这种真正全局的一份。每个页面各自的表单数据不要放进单例，两扇窗口会改到一起。

### 2.5 元素之间怎样把消息传过去

同一文档里有四种常用方式。它们解决的不是同一件事。

绑定表达“这个属性永远等于那个表达式”。数据源用属性的 `NOTIFY` 通知变化。适合标题、进度、是否可用。

信号表达“这一次发生了”。`Button` 的 `clicked`、你自己 C++ 对象的 `failed`，都是信号。同文档里用 `onClicked` 这种处理器。处理器要写在别的对象上时，用 `Connections`：

```qml
Connections {
    target: backend
    function onFailed(message) {
        dialog.text = message
    }
}
```

`onFailed` 对应信号 `failed`。参数表和信号一致。`target` 换成另一个对象，就改听那一个，不必把函数写进那个对象内部。

子组件不要直接写外层某个 `id`。那样组件只能活在这一份父文档里，放进 `ListView` 的委托就会去找一个不存在的名字。需要的数据声明成 `required property`，由创建处传入：

```qml
// Row.qml
Rectangle {
    required property string title
    required property int index
    Text { text: title }
}
```

父组件若要让外面改子组件的某个属性，用 `property alias` 起一个对外的名字，指向子项的属性。外面不直接伸手改子项里没公开的那一层。

绑定可以形成环：甲的宽度绑定乙，乙的宽度又绑定甲。运行时会有警告，值停在打断之前的那一次。发现警告里有两处属性互相引用，就拆掉一处，改成只在一个方向上绑定。

### 2.6 基本项、控件和布局

`import QtQuick` 之后，`Item` 是所有可见项的基类。它自己不画出像素，用来分组、定位、接收子项。`Rectangle` 画填充和边框，`Text` 画文字，`Image` 画图片。它们都是 `Item`。

位置有两种常见写法。锚把一项的边贴到另一项的边：

```qml
Rectangle {
    anchors.left: parent.left
    anchors.right: parent.right
    anchors.top: parent.top
    height: 48
}
```

父项变宽时，这块矩形的宽度跟着变。锚适合少量、关系固定的项。一排按钮要随语言长短重新分配空隙时，用 `QtQuick.Layouts` 的 `RowLayout`、`ColumnLayout`。布局项使用 `Layout.fillWidth` 这类附加属性，不和锚混在同一项上。又写锚又写布局，一项会收到两套位置，结果不稳定。

`QtQuick.Controls` 里的 `Button`、`TextField`、`Slider`、`Popup` 已经处理了焦点、禁用和基本键盘操作。外观要完全自绘时再从 `Item` 搭。只为了少写一个 import 而用矩形假装按钮，焦点和可读性都要重做。

`Image` 和 `Text` 的资源 URL，模块内的文件用相对路径。从资源系统来的写成 `qrc:/` 或模块提供的路径。文件没打进模块时，开发机上也许能看见，换一台机器就空白。

### 2.7 鼠标、键盘和焦点

指针输入在 Qt 6 里用处理器。一个项上可以放多个处理器，由框架分配手势，而不是用一个巨大的 `MouseArea` 盖住所有兄弟项再在里面判断。

```qml
Rectangle {
    TapHandler {
        onTapped: backend.activate()
    }
    DragHandler {
        onActiveChanged: if (active) parent.anchors.left = undefined
    }
}
```

`TapHandler` 处理点击。`DragHandler` 在拖动期间给出位移。`HoverHandler` 处理指针是否在项上，不需要按下。`WheelHandler` 处理滚轮。`MouseArea` 仍能用，适合“这一块矩形整体响应按下和移入”。新写的手势优先用处理器，避免多个 `MouseArea` 互相挡住。

处理器看到的是这项上的指针事件。项若被兄弟项盖住且那个兄弟项接受指针，下面的处理器收不到。看不出为什么点了没反应时，先看谁在上层、谁设了更大的面积。

键盘只送给有焦点的项。`activeFocus` 为真才是当前接收按键的那个。容器用 `FocusScope` 把“这块区域里的焦点”收成一个范围，方便整页切换。`Keys.onPressed` 写在有焦点的项上。全窗口的快捷键用 `Shortcut`，它不依赖某个小矩形当前是否聚焦。

```qml
Item {
    focus: true
    Keys.onPressed: (event) => {
        if (event.key === Qt.Key_Return)
            event.accepted = true
    }
}
```

`accepted` 为真表示这次按键不再往父项传。输入框自己会消费字符键。要在输入框之外响应回车，把 `Shortcut` 放在窗口上，不要和输入框抢同一个 `Keys` 处理器。

### 2.8 列表

重复的一行用模型加委托，而不是在 QML 里复制一百份矩形。

`Repeater` 把模型的每一条变成一个子对象，全部创建出来，适合条数少、要同时排版的情况。`ListView` 只创建可见范围附近的委托，适合长列表。两者的委托都是一个 `Component`。委托里用 `required property` 接模型的字段，这是 Qt 6 里推荐的写法，避免依赖外面的名字。

```qml
ListView {
    model: backend.entries
    delegate: Row {
        required property string name
        required property int cost
        Text { text: name }
        Text { text: cost }
    }
}
```

模型是 C++ 的列表模型时，字段来自角色名。QML 的 `ListModel` 适合演示和很小的静态表。会增删、会从网络或设备来的数据，放在 C++ 模型里，委托才不会整表推倒重建。

### 2.9 状态和动画

状态是一套属性值的名字。`state` 切到另一个名字时，列在那个状态里的属性写上去。过渡描述这次切换要不要用时间插值。

```qml
Rectangle {
    id: box
    states: State {
        name: "wide"
        PropertyChanges { box.width: 200 }
    }
    transitions: Transition {
        NumberAnimation { property: "width"; duration: 150 }
    }
}
```

只是“宽度永远等于父项的一半”时用绑定，不要为它建状态。状态适合几套互斥的外观：展开和收起、普通和报警。动画的属性若同时还写着绑定，两者会抢这个属性。决定一个方向之后拆掉另一个。

### 2.10 Quick 3D

Quick 3D 不是第二个窗口框架。`View3D` 是一个 `Item`，在二维场景里占一个矩形，矩形内部是三维节点树。外面的按钮仍然是 Quick 的控件，可以叠在 `View3D` 上面或下面，遮挡由场景图的先后决定。

```qml
import QtQuick
import QtQuick3D

View3D {
    anchors.fill: parent
    environment: SceneEnvironment { backgroundMode: SceneEnvironment.Color; clearColor: "black" }
    PerspectiveCamera { z: 300 }
    DirectionalLight { }
    Model {
        source: "#Cube"
        materials: PrincipledMaterial { baseColor: "orange" }
    }
}
```

`PerspectiveCamera` 决定投影。灯光决定明暗。`Model` 是网格，`source` 可以是内建立方体，或模块里的网格资源。这些节点的父级是三维树里的 `Node`，不是外面某个 `Rectangle` 的视觉子项。二维的 `parent` 管的是 `View3D` 这一整个项在窗口里的位置。

点选三维物体要用 Quick 3D 的拾取，把屏幕坐标变成射线。`TapHandler` 放在 `View3D` 上只能告诉你点在这项的哪一个像素，不能直接给出网格上的三角面。拾取结果再写回 C++ 或 QML 属性。

网格和纹理放进模块。不要在每一帧的绑定表达式里生成大量顶点。顶点准备在 C++ 完成，QML 改位置、旋转和是否可见。三维渲染仍走 Quick 的渲染线程规则：属性在 GUI 线程改，提交在渲染线程进行。

## 三、C++ 和 QML 怎样接到一起

QML 文档和 C++ 类跑在同一个进程里，窗口也是同一个。麻烦的地方在于，两边没有共用一套能直接点名的接口。QML 看见的是元对象表里登记过的名字。C++ 看见的是自己的类。像素又走第三条路：场景图，不经过函数调用。先把这道边界看清楚，再按你实际要做的事选择通道。类型怎样注册进模块，第二节已经写过。这里默认类已经带 `QML_ELEMENT`，并且 QML `import` 了那个 URI。

### 3.1 麻烦在什么地方

C++ 类里的公有函数、成员变量，编译器认识，QML 不认识。QML 能写出来的，是 moc 扫到并放进元对象表的那一部分：`Q_PROPERTY` 声明的属性，`signals` 里的信号，`public slots` 或 `Q_INVOKABLE` 标记的函数，`Q_ENUM` 登记的枚举。表上没有的名字，QML 里写出来就是类型错误，哪怕 C++ 里那一行是 public。

所以成员变量要给 QML 用，先把它做成属性。属性约定三件事：怎么读，怎么写，变了通知谁。通知是 `NOTIFY` 信号。C++ 把成员改了却不发这个信号，变量在调试器里已经是新值，绑定它的文字还停在旧值。这件事在第一节的属性里讲过，这里所有“两边都看同一份数据”都建立在它上面。

函数调用、数据、像素是三件不同的事，用错通道就会觉得“连接很乱”。

调用是一次动作。按钮按下，QML 调用 C++ 的 `refresh()`。C++ 要打开一个只在 QML 里写好布局的对话框，那也是一次调用，或者一次信号。动作做完就结束，没有“一直等于”。

数据是一份会持续变化的状态。标题、采样、当前行，QML 用绑定订着。C++ 改值并发出 `NOTIFY`，订过的界面跟着变。这不是反复去调一个函数把字符串塞进某个 `Text`。

像素是这项在自己的矩形里画什么。QML 负责把这项放在窗口的哪一块、挡在谁上面。画进矩形的顶点、着色器、渲染通道在 C++ 的项里准备好。窗口的渲染循环到了同步点会来取，QML 不调用一个叫“渲染”的函数。

另外两件事让边界更窄。

对象有两边的生命周期。QML 里写出 `Backend { }` 时，这个 C++ 对象挂在 QML 对象树上，树拆掉它就被删。C++ 函数若 `return new Something`，没有父对象时，引擎默认改成 JavaScript 所有权，QML 不再引用它，垃圾回收会把它删掉。C++ 还留着那只指针，下一次使用就是悬空。要由 C++ 继续持有，就给它父对象，或 `QQmlEngine::setObjectOwnership(obj, QQmlEngine::CppOwnership)`。

QML 对象只在 GUI 线程上使用。工作线程可以算，算完用信号把结果送到 GUI 线程，再写属性。渲染线程可以画，画的时候只读这一帧已经拷走的数据。在工作线程或渲染线程里改 QML 属性、调用 QML 函数，元对象系统不会替你把这次访问变成安全的。

方向上也有一条习惯：QML 可以 `import` 并依赖 C++ 类型。C++ 业务对象不去记住某一份 QML 文件里有哪些 `id`。界面结构一改，那些名字就对不上。业务对象对外是属性、信号和函数。QML 决定怎么把它们摆成界面。

### 3.2 先分成几类

动手前先对上号，后面每一节只解决一类。同一块界面经常四类都有，它们仍然分开写。

| 你要做的事 | 走哪一节 |
| --- | --- |
| 界面要执行一段 C++，或读取、修改 C++ 已经公开的状态 | 3.3 QML 使用 C++ |
| C++ 要拿到用户输入，或让界面做一件只有 QML 会做的事 | 3.4 C++ 使用 QML |
| 两边都要读、也都要写同一份业务数据，并且之后还要变 | 3.5 同一份数据 |
| 某一块矩形里的像素得由 C++ 产生，位置和遮挡仍由 QML 排 | 3.6 像素 |

后面用同一块“采样图”当例子，好对照这四条通道。设备不断送来一组点。界面上有标题、一个刷新按钮、一条折线，旁边还要显示数值。标题和按钮是 3.3。按钮把用户的意思送进 C++、C++ 再让 QML 弹出说明，是 3.4。点列本身两边都要读写，是 3.5。折线若用现成的 `Rectangle` 画不出来，是 3.6。换一块别的界面时，先对这张表，再套后面的写法。

### 3.3 QML 使用 C++

QML 对一个 C++ 对象能做的，就是元对象表上那几类名字。

调用函数。函数写在 `public slots` 里，或标成 `Q_INVOKABLE`。普通公有函数即使 C++ 别的类能调，QML 也不能。参数和返回值必须是元类型：数值、布尔、`QString`、`QColor`、`QUrl`、`QDateTime`、`QVariant`、`QVariantList`、`QVariantMap`，以及已经注册的 `QObject` 指针、值类型、枚举。自己的结构体若只有 C++ 成员、没有元类型，不能出现在这个签名上。同名函数重载多了，QML 往往分不清该调哪一个，需要给 QML 用的那一个单独起名字。

读和写数据。QML 写 `backend.title`，读的是属性的 `READ`，赋值走 `WRITE`。类里的 `m_title` 对 QML 不存在。只读属性不写 `WRITE`，QML 不能赋值。`MEMBER` 可以把属性直接映射到一个成员，省掉手写读写函数，通知仍然要你在 C++ 改成员之后发出，`MEMBER` 不会自动发。

听一件已经发生的事。C++ `emit failed(message)`，同一份文档里可以写 `onFailed`，或用 `Connections` 听另一个对象。这是信号，不是 QML 去轮询一个函数。

使用枚举。枚举放在有元对象的类型里，加 `Q_ENUM`。QML 写 `Link.Up`，不写魔法数字。

使用子对象。属性的类型是另一个 `QObject` 指针时，QML 可以继续点它的属性，例如 `backend.link.state`。那个子对象要在 C++ 里活得比这次访问更久，规则和上面的所有权一样。

```cpp
class Backend : public QObject
{
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QString title READ title NOTIFY titleChanged)
public:
    explicit Backend(QObject *parent = nullptr) : QObject(parent) {}

    QString title() const { return m_title; }

    Q_INVOKABLE void refresh()
    {
        m_title = QStringLiteral("已刷新");
        emit titleChanged();
    }

signals:
    void titleChanged();

private:
    QString m_title;
};
```

```qml
import MyApp
import QtQuick
import QtQuick.Controls

Window {
    Backend { id: backend }
    Label { text: backend.title }
    Button {
        text: "刷新"
        onClicked: backend.refresh()
    }
}
```

这个例子里，`title` 是数据，`refresh()` 是动作。`Label` 绑定属性，按钮调用函数。点击发生在 GUI 线程，所以 `refresh()` 也在 GUI 线程执行。它可以改成员、发信号。它里面不能睡眠等套接字或磁盘。需要等待时，发起异步操作，完成之后用信号回到 GUI 线程再改 `title`。异常也不要抛过这道边界。QML 接不住 C++ 异常。失败改成返回值，或再发一个 `failed` 信号，由 QML 显示。

从函数里返回一个新建的 `QObject` 时，先决定谁删除它。交给 QML 管、并且没有父对象，就保持引擎默认的 JavaScript 所有权，QML 用属性或变量接住返回值。C++ 还要留着这份对象，就设置 `CppOwnership` 并保证有人 `delete`，或给一个 C++ 父对象。

业务对象放进模块之后，由 QML 写出实例，或做成 `QML_SINGLETON`。不要把主要对象只用 `setContextProperty` 挂到根上下文上。那样 QML 里会出现一个 `import` 里没有的名字，组件拷到别处就不能用，静态检查也看不到它。上下文属性只留给极少数必须在加载前塞进引擎的钩子。

### 3.4 C++ 使用 QML

C++ 真正想从界面拿到的，多半是用户刚刚做了什么，或界面现在处于哪一种状态。这些信息用上一节的反方向送进来即可：QML 在信号处理器里调用 C++ 函数，把文本、下标、是否勾选当参数传过去；或把 C++ 的可写属性绑到界面上的值，让属性的 `WRITE` 在变化时被调用。业务对象因此不需要保存 `TextField` 的指针。

常见的几种输入，对应关系是：

| 想要的 | 常见做法 |
| --- | --- |
| 按钮被按下 | QML 的 `onClicked` 调用 C++ 函数 |
| 文本框里的内容 | `editingFinished` 时把 `text` 作为参数传给 C++，或把 C++ 的可写属性设为这份文本 |
| 列表当前行 | 把 `currentIndex` 写进 C++ 的属性，或在变化时调用函数并传入下标 |
| 某项现在多宽、多高 | 这项自己的 C++ 类读 `width()` 和 `height()`。业务对象不另存一份从 QML 抄来的尺寸 |
| 鼠标在图上的位置 | 图这一项上的处理器把坐标传给 C++。业务对象不去问“窗口里现在的鼠标” |
| 打开一个只有 QML 会排版的弹层、切换一页、播放一段只写在 QML 里的动画 | C++ 发信号，QML 里做这件界面的事 |

最后一行才是“C++ 调用 QML”。前几行都是 QML 把输入交给 C++。能用信号或属性解决的界面动作，就不要去把 QML 函数当 C++ 虚函数来调。C++ 发 `noticeRequested(text)`，QML 写：

```qml
Connections {
    target: backend
    function onNoticeRequested(text) {
        dialog.text = text
        dialog.open()
    }
}
```

信号的参数就是 C++ 要交给界面的内容。QML 决定对话框长什么样。C++ 不知道这份文档里对话框的 `id`。

有的动作必须落到某一个已经存在的 QML 对象上，信号也没处挂。这时用 `QMetaObject::invokeMethod`，调用那个对象上的 JavaScript 函数。对象指针要事先就有：要么是你加载时留下的根对象，要么是 QML 曾经作为参数传给你的项。调用落在对象所属的线程。人已经在别的线程上时，用 `Qt::QueuedConnection`。

```cpp
QMetaObject::invokeMethod(page, "showNotice", Q_ARG(QString, message));
```

```qml
function showNotice(message) {
    dialog.text = message
    dialog.open()
}
```

`page` 从哪来要明确。`engine.rootObjects()` 是 `loadFromModule` 成功之后的根对象列表，可以留下根，再让根的一个属性公开你要的那一页。靠 `objectName` 加 `findChild` 在整棵树里搜，只适合调试。`id` 和 `objectName` 不是同一个东西：`id` 只在那一份 QML 文档里有效，第一节说过，它不会变成 C++ 能搜到的对象名。

C++ 有时要自己创建一块 QML，而不是调用一块已经在树上的界面。用 `QQmlComponent` 按模块 URI 和类型名加载，`create()` 得到根对象，看 `errorString()` 判断失败，再给父对象、决定所有权。界面对此更常见的写法是 QML 自己的 `Loader`：C++ 只改一个 URL 或一个状态属性，由文档决定把哪个组件创建出来。业务代码里反复 `create()` 一份写死的 QML 路径，界面一改名，C++ 就要跟着改。

### 3.5 两边读写同一份数据

“同一份数据”指双方以后读到的是同一次发布的结果，并且任何一方改了，另一方还能知道。它不是两套语言同时拿着同一个成员变量随便写。QML 读属性的时候不会加锁。工作线程写这个成员的同时，绑定或渲染去读，数据会裂。

发布点放在 GUI 线程上的一个对象里。两边都通过属性访问它。C++ 改值只走写函数，写函数在值变化时发出 `NOTIFY`。QML 对可写属性赋值时，引擎调用的也是这个写函数。读走 `READ`。这样界面绑定、别的 C++ 代码、以及后面要拿去画的那一项，看到的是同一份已经发布的数据。

```cpp
Q_PROPERTY(QVector<QPointF> samples READ samples WRITE setSamples NOTIFY samplesChanged)

void Backend::setSamples(const QVector<QPointF> &samples)
{
    if (m_samples == samples)
        return;
    m_samples = samples;
    emit samplesChanged();
}
```

QML 里 `text: backend.title` 这种写法是绑定：`titleChanged` 之后表达式会重算。若后来对这个 `text` 本身赋值，这份绑定就卸了，之后 C++ 再发 `titleChanged` 也不会再写进这个 `text`。需要恢复时用 `Qt.binding(() => backend.title)`。对 `backend.title` 赋值是另一件事，它调用写函数，别的仍然绑在 `title` 上的表达式继续有效。

一个属性只留一个发布者。设备和人都要改点列时，分成两个属性：`deviceSamples` 只由设备结果写入，`editedSamples` 只由界面写入。C++ 再维护一个只读的 `displaySamples`。来源或当前状态变化时，由 C++ 算出要显示的那一列，写进 `displaySamples` 并发出它的 `NOTIFY`。QML 和绘制项只绑定这一份。两个来源轮流写同一个属性时，后写的覆盖先写的，绑在它上面的表达式还可能再写回来，数值会自己跳。

工作线程不接触这个对象。线程里算完，发出带结果的信号。`Backend` 活在 GUI 线程，连接会自动排队，槽在 GUI 线程执行，在槽里调用 `setSamples`。参数用值传递。`QString`、`QVector` 这类 Qt 容器是隐式共享的，排队时的拷贝在还没人改它之前并不复制全部字节。自己的结构体要先成为元类型，队列连接才肯运送它。`QThread` 怎样把 `exec()` 跑起来，第一节已经写过。这里只要求：QML 看见的那次写发生在 GUI 线程。

数据的形状不同，载体也不同。

一个会持续变化、并且别处还要指着它的对象，用 `QObject` 和 `Q_PROPERTY`。QML 绑定的是属性名。

一小包字段、复制一份就能用、没有自己的信号，用值类型。`Q_GADGET` 生成元对象，但没有信号，也不能有父对象。字段用 `Q_PROPERTY` 暴露，Qt 6 里再用 `QML_VALUE_TYPE` 注册成 QML 能写出的类型。

```cpp
struct Reading
{
    Q_GADGET
    QML_VALUE_TYPE(reading)
    Q_PROPERTY(double value MEMBER value)
    Q_PROPERTY(QString unit MEMBER unit)
public:
    double value = 0;
    QString unit;
};
```

QML 里访问 `reading.value`。传递时是拷贝。值类型自己不会因为某个字段变了就发信号。持有它的那个 C++ 属性要再发一次自己的 `NOTIFY`，界面才知道整份读数换了。

字段集合不稳定、只是临时一包键值时，用 `QVariantMap`。QML 会当成对象去点字段。少声明一个类型时可以用。字段名拼错不会在编译时暴露。要长期当接口的，用上面的值类型或一个小的 `QObject`。

枚举是双方都认识的一组名字，用 `Q_ENUM`，作为属性时同样带 `NOTIFY`。

一组行，用 `QAbstractListModel`。`rowCount` 是行数，`data` 按角色返回一列，`roleNames` 把角色号映射成 QML 里的属性名。插入和删除前后调用 `beginInsertRows` 与 `endInsertRows`，视图才知道哪一段变了。整表换掉用 `beginResetModel`。不要每来一个新读数就销毁模型再 `new` 一个，`ListView` 的滚动位置和委托会全部重建。

```cpp
class ReadingModel : public QAbstractListModel
{
    Q_OBJECT
    QML_ELEMENT
public:
    enum Role { ValueRole = Qt::UserRole + 1, UnitRole };
    int rowCount(const QModelIndex &parent = {}) const override;
    QVariant data(const QModelIndex &index, int role) const override;
    QHash<int, QByteArray> roleNames() const override
    {
        return { { ValueRole, "value" }, { UnitRole, "unit" } };
    }
};
```

委托里的 `required property double value` 就是角色名 `value`。C++ 追加一行并发出插入通知之后，这一行的委托才会被创建。模型仍然只在 GUI 线程上改。工作线程送来的是一批新行，GUI 线程的槽里再 `beginInsertRows`。

选择可以收成一句：一个值用属性，一小包字段用值类型，很多行用模型，一次发生的事用信号，一次要执行的动作用可调用函数。像素不在这个选择里。

### 3.6 一块区域的像素由自己产生：选入口并接完整链路

前几节解决了“C++ 和 QML 怎样交换动作、状态、列表”。自定义渲染还多一个问题：**这一块矩形里的像素由谁生成**。例如数据可能是一组折线顶点、一张标量热力图、一帧多平面视频，或者已有的 RGB 纹理。先确定输入的形态与所有权，再决定用哪种绘制入口；QML 依旧只负责这块区域的尺寸、位置和与其他控件的叠放。

| 你要自定义什么 | 合适的入口 | 需要自己负责的部分 |
| --- | --- | --- |
| 已经有可由 Qt Quick 提供的纹理，只改颜色或做简单效果 | `ShaderEffect` | 片元/顶点着色器及其参数；Qt 提供输入纹理 |
| 自己生成点、线、三角形，或给它们定义材质 | `QQuickItem::updatePaintNode()` | 场景图几何节点、材质及数据同步 |
| 要控制纹理上传、渲染目标和一整次 GPU 绘制 | `QQuickRhiItem`（Qt 6.7+） | QRhi 资源、管线、命令和输出纹理 |
| 有现成 `QPainter` 绘图代码需要搬入 Quick | `QQuickPaintedItem` | `QPainter` 绘制；Qt 再把结果纳入场景 |

`ShaderEffect` 本身是 QML 项。它适合输入**已经是可采样纹理**的情况；多项 QML 内容可以先经 `ShaderEffectSource` 合成一张纹理，但这会增加一次离屏绘制和显存占用。一块原始 NV12 内存不会因为写了 `sampler2D` 就自动成为 Y、UV 两张纹理。要自己处理原始缓冲，仍要在 C++ 侧解决上传和资源生命周期。[Qt：ShaderEffect](https://doc.qt.io/qt-6/qml-qtquick-shadereffect.html)、[Qt：ShaderEffectSource](https://doc.qt.io/qt-6/qml-qtquick-shadereffectsource.html)

#### 先从最小自定义项理解场景图

继承 `QQuickItem` 后，构造时设置 `ItemHasContents`；GUI 线程更新属性后调用 `update()`；Qt Quick 在同步阶段调用 `updatePaintNode(oldNode, ...)`。第一次 `oldNode` 为空就建立节点，后续尽量复用。以下是核心结构，颜色属性的读写函数按 1.5 节的 `Q_PROPERTY` 规则实现：

```cpp
class ColorBlock : public QQuickItem
{
    Q_OBJECT
    QML_NAMED_ELEMENT(ColorBlock)
public:
    explicit ColorBlock(QQuickItem *parent = nullptr) : QQuickItem(parent)
    {
        setFlag(ItemHasContents, true);
    }
protected:
    QSGNode *updatePaintNode(QSGNode *oldNode, UpdatePaintNodeData *) override
    {
        auto *node = static_cast<QSGRectangleNode *>(oldNode);
        if (!node)
            node = window()->createRectangleNode();
        if (!node)
            return nullptr;
        node->setRect(boundingRect());
        node->setColor(Qt::red);
        return node;
    }
};
```

这个片段需要 `QQuickItem`、`QQuickWindow`、`QSGRectangleNode` 和 QML 注册头文件；类要列进 QML 模块的 `SOURCES`。在 QML 写 `ColorBlock { width: 240; height: 140 }`，若能看到红色矩形，就证明“C++ 类型注册 → QML 布局 → 同步 → 节点 → 窗口合成”已通。`window()->createRectangleNode()` 让节点适配当前场景图后端。[Qt：QQuickItem::updatePaintNode](https://doc.qt.io/qt-6/qquickitem.html)、[Qt：创建矩形节点](https://doc.qt.io/qt-6/qquickwindow.html)

要画折线，把单色矩形节点换成保存顶点的 `QSGGeometryNode`：数据变化时更新顶点；材质决定线或三角形内的颜色。需要自己的片元算法时，再实现 `QSGMaterial`/`QSGMaterialShader` 并加载 `.qsb` 着色器。**几何回答“画在哪些位置”，材质回答“这些位置的像素怎么算”。**`updatePaintNode()` 只在同步阶段更新节点，不在 GUI 按钮槽里保存并修改 QSG 指针，也不从这里发信号反过来改 QML。[Qt：自定义材质示例](https://doc.qt.io/qt-6/qtquick-scenegraph-custommaterial-example.html)

#### 当自己要安排完整 GPU 通道时

若输入是多张纹理、需要上传原始缓冲并控制整个绘制通道，`QQuickRhiItem` 是 Qt 6.7 起的一个入口。它仍是 `QQuickItem`，照常写在 QML 的布局里；还需配一个 `QQuickRhiItemRenderer`。该项管理输出颜色缓冲，渲染器负责把最终像素画进去，Qt Quick 再把它作为项的一块内容合成到窗口。Qt 6.5 项目可走 `QSGMaterialShader` 自定义材质路线；`QQuickRhiItem` 及部分 QRhi API 有版本兼容性限制。[Qt：QQuickRhiItem](https://doc.qt.io/qt-6/qquickrhiitem.html)

| 回调 | 所在环节 | 负责的事 |
| --- | --- | --- |
| 项的属性 setter、接收数据函数 | GUI 线程 | 保存新状态，发 `NOTIFY`，调用 `update()` |
| `createRenderer()` | 渲染器创建 | 返回一个属于该项的渲染器实例 |
| `synchronize(item)` | 同步阶段 | 从 GUI 项复制本次需要的稳定数据快照 |
| `initialize(cb)` | 资源建立或失效后重建 | 创建纹理、顶点/参数缓冲、资源绑定和图形管线 |
| `render(cb)` | 绘制阶段 | 上传变化的资源，`beginPass`、绑定管线、draw、`endPass` |

`synchronize()` 发生在 GUI 线程暂停时，因此可以安全地把项状态复制给渲染器；之后 `render()` 只使用渲染器自己的副本，不在绘制时读写 QML 对象。输出的颜色纹理由 `QQuickRhiItem` 交给 Qt Quick。窗口大小、后端或渲染目标格式变化时，`initialize()` 可能再次执行，pipeline 要跟新的 `renderTarget()` 匹配，不能只在第一次启动时创建一次。[Qt：渲染器回调](https://doc.qt.io/qt-6/qquickrhiitemrenderer.html)、[Qt：完整 RHI 项示例](https://doc.qt.io/qt-6/qtquick-scenegraph-rhitextureitem-example.html)

一个自定义绘制任务可以逐格落实为“**输入数据 → GPU 资源 → 几何 → 着色规则 → 输出目标**”：折线用点列和顶点缓冲；热力图用标量纹理和查色表着色器；视频用图像平面纹理和颜色转换着色器。GPU 绘制以前要先让数据拥有正确的资源形态。Qt 6 中 `.vert/.frag` 通常在构建时由 `qt_add_shaders()` 编译为 `.qsb`，运行时加载的是 `.qsb`，不是临时编译 GLSL 字符串。[Qt：Shader Tools 构建集成](https://doc.qt.io/qt-6/qtshadertools-build.html)

工作线程不直接写 Quick 项或 QRhi 资源。它产出一份可安全持有的数据，经队列连接交到 GUI 线程；GUI 项更新当前快照并 `update()`；同步阶段再交给渲染器。实时预览常保留最新的一份，丢掉来不及显示的旧帧；若任务不能丢数据，就另设有限队列。**帧数据的生命周期必须覆盖上传或绘制所需的时间**，否则第一帧偶尔正确、后续花屏和崩溃会很难定位。

### 3.7 把 NV12 代入这条通用链路

NV12 在这里是应用例子，目的是核对上一节每个环节。假设摄像头或解码器交来一帧 8 位 NV12：Y 平面有 `W×H` 个亮度样本，UV 平面按 U/V 交错存储、逻辑尺寸是 `W/2×H/2`。生产者还必须给出每平面的 `stride`、可见宽高、颜色空间/范围等信息。`stride` 是相邻两行起点的**字节距离**，有 padding 时不等于 `W`。如果来源是 `QVideoFrame`，映射后才能用 `bits(plane)` 与 `bytesPerLine(plane)` 访问 CPU 数据；GPU 句柄帧映射到 CPU 可能产生额外复制。[Qt：QVideoFrame](https://doc.qt.io/qt-6/qvideoframe.html)

```text
采集/解码线程：得到 NV12，确认 Y/UV 地址、stride 与缓冲区生命周期
→ GUI 线程：发布一份稳定帧快照，通知自定义项更新
→ 同步阶段：渲染器取得这一帧及亮度等处理参数
→ GPU 资源：Y 上传为 R8(W×H)，UV 上传为 RG8(W/2×H/2)
→ 绘制：全屏矩形的片元着色器采样 Y、UV，换算 RGB 并执行额外图像运算
→ 输出：画进自定义项的颜色缓冲，由 Qt Quick 与按钮、文字合成
```

若源是 V4L2 MMAP 缓冲，归还缓冲给驱动前，要复制数据或建立能持续到上传完成的安全引用；不能把一根指向即将被复用内存的指针当成“一帧”。上传时用两个平面的真实 stride。`QRhiTextureSubresourceUploadDescription::setDataStride()` 要求当前后端支持 `ImageDataStride`；不支持时先逐行去掉 padding 再上传紧密副本。`R8` 和 `RG8` 的支持也要向当前 RHI 查询。[Qt：QRhi 纹理格式](https://doc.qt.io/qt-6/qrhitexture.html)、[Qt：上传行跨度](https://doc.qt.io/qt-6/qrhitexturesubresourceuploaddescription.html)

片元着色器拿同一个纹理坐标分别读 Y 与 UV，UV 纹理的分辨率减半，采样器负责取到该位置的色度值。以下只示意 **8 位 BT.709 有限范围**；换成 BT.601、全范围、NV21 或更高位深时，偏移、系数或 U/V 顺序必须变，不能仅凭“NV12”固定一种矩阵。[Qt：QVideoFrameFormat 颜色元信息](https://doc.qt.io/qt-6/qvideoframeformat.html)

```glsl
float y = texture(yTex, texCoord).r;
vec2 uv = texture(uvTex, texCoord).rg;
float yy = 1.16438356 * (y - 16.0 / 255.0);
float cb = uv.r - 128.0 / 255.0;
float cr = uv.g - 128.0 / 255.0;
vec3 rgb = vec3(yy + 1.79274107 * cr,
                yy - 0.21324861 * cb - 0.53290933 * cr,
                yy + 2.11240179 * cb);
rgb = clamp((rgb - 0.5) * contrast + 0.5 + brightness, 0.0, 1.0);
```

公式只负责**像素怎么算**。渲染器仍要把两张纹理绑定到对应采样器，把 `brightness/contrast` 等参数放到着色器可见的 uniform 缓冲，并画覆盖输出矩形的几何。最终颜色写入自定义项的输出纹理；QML 看到的仍是一个有尺寸的项，可以用 anchors、布局、`z` 和透明度。若显示比例和输入比例不同，要明确选择留黑、裁剪还是拉伸；这属于几何与纹理坐标，不属于颜色矩阵。

如果只是先把视频显示出来，可把合法 `QVideoFrame` 交给 `QVideoSink`/`VideoOutput`，由 Qt Multimedia 完成常规显示与颜色转换，再按需要附加效果。它的最终结果同样是 QML 项，但颜色转换由 Qt 负责，并非自己实现了 Y/UV 两纹理着色器。先区分目标是“显示视频”还是“控制每一步 GPU 处理”，再选高层或自定义入口。[Qt：QVideoSink](https://doc.qt.io/qt-6/qvideosink.html)、[Qt：VideoOutput](https://doc.qt.io/qt-6/qml-qtmultimedia-videooutput.html)

## 四、第一版按这个顺序做

1. 用当前工程的 CMake、`main.cpp` 与一个只有 `Window`、`Text` 的 QML 文件跑通窗口和事件循环。确认模块 URI、`loadFromModule` 与 QML 类型加载都正确。
2. 加一个带 `Q_PROPERTY`、`NOTIFY` 和 `Q_INVOKABLE` 的业务对象，按 3.3 节让按钮调用动作、文字绑定状态。这样先把 C++ ↔ QML 通道跑通。
3. 有工作线程时，让它只产生数据，通过信号把结果送到 GUI 线程的对象。GUI 线程发布一个稳定的数据快照；不要让采集线程直接改 QML 项或 GPU 资源。
4. 现成 Quick 项足够就用现成项。若要证明自定义项接入，先按 3.6 节做一个固定颜色的 `QQuickItem` 节点，放进 QML 布局，上面叠一个按钮。先见到这块颜色，再加入真实数据。
5. 按实际绘制需求选择 `ShaderEffect`、`QSGGeometryNode`/自定义材质或 `QQuickRhiItem`。确认输入资源、几何、着色规则、输出目标分别由谁负责；先用固定测试纹理或固定顶点验证，再接实时输入。
6. 以 NV12 为例时，先显示 Y 灰度，再加入 UV 和正确的色彩矩阵，最后加亮度/对比度等处理。每一步看输入格式、stride、纹理绑定和输出，不把“黑屏”统称为 shader 错误。
7. 正确性通过后再做性能工作：复用资源、限制队列、分析上传带宽，必要时研究 DMA-BUF/GPU 纹理导入。零拷贝涉及图形后端、格式与同步约束，不能以一个文件描述符替代整条验证链。

Qt 的其他内容——对象生命周期、信号槽、事件循环、QML 组件、输入、列表、状态动画、Quick 3D 与 C++/QML 双向交互——仍是本篇前面各节的基础。自定义渲染只是这些机制共同服务的一类任务：**QML 管页面中的项，C++ 管数据与对象，渲染入口管项内部的像素。**
