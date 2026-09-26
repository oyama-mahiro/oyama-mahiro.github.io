---
title: "[C++] 基础复习"
published: 2024-03-13
tags: [C++, 复习]
category: C++
draft: false
---
# <font color=green>C++复习-基础部分</font>

<br>
<br>

---



## 一、编译，链接


### 1.1 预处理（Preprocessing）
- **工作内容**：
  - 展开宏定义（`#define`指令）。
  - 处理条件编译指令（如`#ifdef`，`#ifndef`，`#endif`）。
  - 处理包含指令（`#include`），将被包含文件的内容插入到源文件中。
  - 删除注释。
  - 添加编译器需要的特殊标记。
- **结果**：生成一个扩展源代码文件，通常这一步骤对程序员是透明的，不产生物理的输出文件。

### 1.2 编译（Compilation）
- **工作内容**：
  - 将预处理后的源代码转换成汇编代码。
  - 进行语法和语义分析，确保代码符合C++语言规范。
  - 优化代码，如循环优化、常量折叠等。
  - 初始化部分全局变量和静态变量
- **结果**：生成汇编语言文件，这些文件包含了可被汇编器直接翻译成机器指令的代码。

### 1.3 汇编（Assembly）
- **工作内容**：
  - 将汇编代码转换成机器语言指令。
- **结果**：生成目标文件（Object File），这些文件包含了机器语言代码但尚未链接。

### 1.4 链接（Linking）
- **工作内容**：
  - 解析和连接外部依赖，如库函数调用。
  - 将多个目标文件合并为一个可执行文件。
  - 处理静态和动态库的链接。
  - 分配全局和静态变量的地址。
  - 解决符号引用，即将函数调用、变量引用等与它们的定义关联起来。
- **结果**：生成最终的可执行文件或库文件。

### 优化
在编译和链接的过程中，编译器会进行多级优化，以提高程序的运行效率和减少程序的大小。优化的级别可以通过编译器选项进行调整。优化工作包括但不限于：
- **编译时优化**：循环展开、内联函数、死代码消除等。
- **链接时优化**（如果支持的话）：进一步优化在编译阶段生成的代码，比如移除未使用的函数或变量。



<br>
<br>

---

## 二、引用

c++中引用可以当作是指针的一种包装，引用变量只能引用已有的变量且无法改变

```cpp
void add(int &b){
    b++;
}

int main(){
    int a = 1;
    add(a);
    std::cout<< a << std::endl; // a=2
}

```


<br>
<br>

---

## 三、类与结构体的区别

* **概念** :struct和class的语法基本相同，struct默认public，class默认private

* **存储** :struct大部分是在程序运行中创建的，在栈上。class用new创建时在堆上

* **关系** :在继承上struct比起class有很大的限制
  
* **使用** :struct在C中不能有成员函数，C++中可以有成员函数


### 3.1 栈与堆

1. 栈上
在使用普通变量时，变量的值是保存在栈上的。
```cpp
A obj;  // 调用默认构造函数
A obj(1, 2); // 调用接受参数的构造函数
A obj = A(1, 2); // 同上，但可能会涉及到拷贝或移动构造函数（编译器优化除外）
```

2. 堆上
在使用new创建对象时，对象的值是保存在堆上的。
```cpp
A *p = new A;  // 调用默认构造函数
A *p = new A(1, 2); // 调用接受参数的构造函数
A *p = new A[10]; // 调用默认构造函数，创建10个对象
```
<br>
<br>

---

## 四、static 和 const

### 4.1 static 

1. 用于变量

* 局部变量：延长生命周期到程序结束，作用域是局部的
* 全局变量或函数：只在定义它的文件中可见
* 类的静态成员变量：没有成员也能存在。所有该类的成员共享。**但是只能在类中声明，要在类的外部进行定义**

2. 用于方法

类的静态成员函数：直接通过类名调用。静态函数只能访问和调用静态成员变量或函数。不能访问非静态成员

3. 用于类

静态类：类的所有成员都是静态的，不能创建对象，只能通过类名访问

><font color=red>注：在普通函数中如果需要返回一个指针,需要：<br>
>1. 将要返回的指针指向的东西设置为static，不然当函数结束后需要返回的空间
>2. 将要返回的指针指向的东西设置为堆中的空间，如malloc，new等 <br>
>
>使其不在栈上，不然函数结束后会被释放</font>

```cpp
int *fun(){
    static int a = 10; //没有static，函数结束后a会被释放，返回的指针指向的是一个不存在的东西
    return &a;
}

int main(){
    int *p = fun();
    printf("%d\n", *p); // 10
}

```

### 4.2 const

1. 用于变量

* `const` 对象不能通过这条名字修改，但内存里的值仍可能被别的非 const 指针改掉
* 必须初始化。它不等于“编译期就替换成字面量”。要编译期常量用 `constexpr`。宏才会无条件做文本替换
* `const` 成员函数承诺不修改非 `mutable` 的成员，可以改 `mutable` 成员。它不能调用非 const 成员函数，除非那些函数也是 const
  
2. 用于方法

* const修饰的方法不能修改成员变量，只能读取成员变量
* const修饰的方法不能调用非const方法，因为非const方法可能会修改成员变量
* const修饰的方法可以被const对象调用，非const对象也可以调用

3. 用于类

* const修饰的类对象不能调用非const方法，因为非const方法可能会修改成员变量


>注：
>* 一般会在函数的参数中使用const引用（如const int &a），防止函数修改参数的值
>* 如果变量被mutable修饰，那么即使是const方法也可以修改这个变量

<br>
<br>

---

## 五、枚举

有意义的数字集合，可以通过枚举来定义。

枚举的默认值是从0开始的，可以通过赋值来改变，后面的值会根据前面的值自动递增。

类中的枚举可以通过类名::枚举内部名称来访问

```cpp
#include <iostream>
using namespace std;

class A{
public:
    enum loglevel{
        INFO=0,
        WARNING=2,
        ERROR  //3
    };

private:
    loglevel level;

public:
    void setLevel(loglevel level){
        this->level = level;
    }
    void printLevel(){
        if(level == INFO){
            std::cout<< "INFO" << std::endl;
        }
        else if(level == WARNING){
            std::cout<< "WARNING" << std::endl;
        }
        else if(level == ERROR){
            std::cout<< "ERROR" << std::endl;
        }
    }
};


int main(){
    A *a = new A();
    a->setLevel(A::ERROR);
    a->printLevel();
}

```


<br>
<br>

---

## 六、类中的知识

### 6.1 构造函数

构造函数用于初始化对象的数据成员。名称与类名相同，没有返回值，可以有参数（一般写成参数列表）,可默认。

可以有多个不同参数的构造函数，称为构造函数的重载。


```cpp
class A{
public:
    int a;
    int b;

    A():a(0),b(0){} // 默认构造函数
    A(int a):a(a){} // 有参数的构造函数
};

```
>注：在创建类的变量时有隐式转换，如A a = 10;会调用A(int a)构造函数，如果不想有隐式转换，可以在构造函数前加explicit

### 6.2 析构函数

析构函数用于释放对象占用的资源。名称与类名相同，前面加上~，没有返回值，没有参数。

析构函数在对象被销毁时自动调用，一般用于释放对象占用的资源，如释放内存、关闭文件等。

```cpp
class A{
public:
    int *p;

    // 构造函数
    A(){
        p = new int[10]; //在堆上分配空间
    }

    // 析构函数
    ~A(){
        delete[] p; //释放空间
    }
};
```

>注：new（delete）与malloc(free)的区别: new会调用构造函数，malloc不会。delete会调用析构函数，free不会

### 6.3 拷贝构造函数

拷贝时如果简单的赋值，如果是指针的话会出现浅拷贝，两个对象的指针指向同一个地址，一个对象释放了空间，另一个对象的指针就会指向一个不存在的地址，会出现问题。

```cpp

class A{
public:
    int *p;

    A(){
        p = new int[10];
    }

    ~A(){
        delete[] p;
    }
};

int main(){
    A a1;
    A a2 = a1; //调用拷贝构造函数
}

//这样就会在a2释放空间时出现问题，因为a1和a2的指针p指向同一个地址，a1释放了空间，a2的指针指向的是一个不存在的地址
```

这样就需要自定义拷贝构造函数，来解决这个问题

```cpp

class A{
public:
    int *p;

    A(){
        p = new int[10];
    }

    A(const A &a){ //拷贝构造函数（也能写列表参数）
        p = new int[10];
        memcpy(p, a.p, 10*sizeof(int)); //深拷贝
    }

    ~A(){
        delete[] p;
    }
};

int main(){
    A a1;
    A a2 = a1; //调用拷贝构造函数
}

```


### 6.4 this指针

this指针是指向当前对象的指针，是一个隐式参数，不需要定义，可以直接使用。

在类的成员函数中，this指针指向调用该成员函数的对象。

```cpp

class A{
public:
    int a;

    A(int a, int b){
        this->a = a;
    }

    int getA() const{
        const A *p = this; //this指针是指向const对象的指针
        return p->a; //这里有点疑惑，只是想说明const方法中需要使用const指针
    }
};


```

### 6.5 智能指针

智能指针就是对指针的封装，可以根据条件自动释放空间。

#### 6.5.1 std::unique_ptr

std::unique_ptr是C++11标准引入的，是一个独占的智能指针，不能被复制，只能被移动。

当离开unique_ptr的作用域时，会自动释放空间。

```cpp

#include <iostream>
#include <memory>

int main(){
    {
    std::unique_ptr<int> p = std::make_unique<int>(10);
    //或者std::unique_ptr<int> p(new int(10));但上面那种有安全保证
    // std::unique_ptr<int> p1 = p; //错误，不能被复制
    }
    // 离开作用域(内部的花括号)，自动释放空间
}

```


#### 6.5.2 std::shared_ptr

std::shared_ptr是一个共享的智能指针，可以被复制，当最后一个shared_ptr被销毁时，会自动释放空间。

std::shared_ptr中有一个引用计数，当有shared_ptr指向一个对象时，引用计数加1，当shared_ptr被销毁时，引用计数减1，当引用计数为0时，释放空间。

```cpp

#include <iostream>
#include <memory>

class Entity{
public:
    Entity(){
        std::cout << "Created Entity!" << std::endl;
    }
    ~Entity(){
        std::cout << "Destroyed Entity!" << std::endl;
    }

};


int main() {
    std::shared_ptr<Entity> sptr = std::make_shared<Entity>();
    {
        std::shared_ptr<Entity> p1 = sptr; //正确，可以被复制
    }
    std::cin.get();
}

```

#### 6.5.3 std::weak_ptr

std::weak_ptr是一个弱引用的智能指针,和shared_ptr一起使用，**不会增加引用计数**，当最后一个shared_ptr被销毁时，会自动释放空间。weak_ptr可以通过lock()方法获取一个shared_ptr，如果shared_ptr不存在，返回一个空的shared_ptr。**weak_ptr可以查询引用计数，但不能访问对象。**

```cpp

#include <iostream>
#include <memory>

class Entity{
        public:

        Entity(){
            std::cout << "Created Entity!" << std::endl;
        }
        ~Entity(){
            std::cout << "Destroyed Entity!" << std::endl;
        }

};


    int main() {
        std::weak_ptr<Entity> wptr;
        {
            std::shared_ptr<Entity> sptr = std::make_shared<Entity>();
            wptr = sptr;
            {
                std::shared_ptr<Entity> p1 = wptr.lock(); //正确，可以被复制
                std::cout << wptr.use_count() << std::endl;
            }
        }
        std::cout << wptr.use_count() << std::endl;
    }

```


### 6.6 继承

在类的定义中，使用`:`来指定继承的类，可以指定访问权限，可以是public，protected，private，默认是private。

```cpp
class A{
protected:
    int a;


public:
    A():a(1){};
    int geta()const{
        return a;
    }

};

class B:public A{
public:
    int b;
    void seta(const int& a){
        this->a = a;
    }
};


int main(){
    B *b = new B();
    b->seta(5);
    std::cout << b->geta() << std::endl;
}
```
* 子类可以访问父类的非私有成员。
* 子类可以重写父类的方法（除了构造函数，析构函数，拷贝函数，重载运算符，友元函数）。
* 用public继承时，父类的public成员在子类中是public，父类的protected成员在子类中是protected
* 用protected继承时，父类的public成员在子类中是protected，父类的protected成员在子类中是protected
* 用private继承时，父类的public成员在子类中是private，父类的protected成员在子类中是private

C++中的继承是单继承，但是可以多重继承，即一个类可以有多个父类。

```cpp

class C:public A, public B{

}

```
但是多重继承会引起菱形继承问题，即一个类有多个父类，而这些父类又有共同的父类，这样就会出现多次继承，导致数据冗余，内存浪费。下面章节详细讨论。

### 6.7 重载

重载是指在同一个作用域中，函数名相同，但是参数列表不同，返回值可以不同。可分为函数重载和运算符重载

#### 6.7.1 函数重载

函数重载即在同一个作用域中，函数名相同，但是参数列表不同。
 ```cpp
    int add(int a, int b){
        return a+b;
    }

    float add(float a, float b){
        return a+b;
    }

    int add(int a, int b, int c){
        return a+b+c;
    }

    int main(){
        std::cout<<add(1,2)<<std::endl;
        std::cout<<add(1.1,2.2)<<std::endl;
        std::cout<<add(1,2,3)<<std::endl;
    }
```


#### 6.7.2 运算符重载

假设有一个类代表的是一个二维向量，如果想将这两个类的对象相加得新的对象。此时运算符重载就有作用。

c++中大部分运算符支持重载。

```txt

返回值类型 operator 运算符(参数) {} ;

```
```cpp

class vector{

public:
    int x,y;
    vector(int x,int y):x(x),y(y){};
    vector():x(1),y(1){};

    vector operator+(const vector& other)const{
        return vector(x+other.x,y+other.y);
    }

    vector operator*(const vector& other)const{
        return vector(x*other.x,y*other.y);
    }

};

//因为<<是对ostream的重载，所以写在类外
std::ostream& operator<<(std::ostream& stream, const vector& other) {
    stream << other.x << "  " << other.y;
    return stream;
}


int main(){
    vector a(1,2);
    vector b(3,4);
    vector c = a+b;
    std::cout<<c<<std::endl;
    int d=8;
     int *const e = &d;
    *e +=1;
    std::cout<<d<<std::endl;
    return 0;
}

```

可重载的运算符：

* 双目算术运算符：+, -, *, /**
* 关系运算符： ==, !=, >=, <=, >, <
* 逻辑运算符： ||, &&, !
* 单目运算符： +(正), -(负), *(指针), &(取地址)
* 自增自减运算符： ++, --
* 位运算符： |, &, ~(按位取反), ^(按位异或), <<, >>
* 赋值运算符： =, +=, -=, *= , /=, %=, &=, |=, ^=, <<=, >>=
* 空间申请与释放：new, delete, new[], delete[]
* 其他运算符: ()(函数调用), ->(成员访问), ,(逗号), [](下标)

>重载，重写，重定义的区别：
>* 重载：在同一个作用域中，函数名相同，但是参数列表不同
>* 重写：子类重写父类的方法
>* 重定义：在子类中定义与父类同名的非虚函数（参数可以不同）

### 6.8 虚函数

- C++中多态即**一种接口，多种方法**，是通过虚函数实现的。

- 虚函数是在基类中声明的，用virtual关键字修饰，子类中可以重写(override)这个函数。

- 当一个类中有虚函数时，会在对象的内存中存储一个虚函数表(virtual table)，这个表中存储了虚函数的地址，当调用虚函数时，会根据对象的虚函数表找到对应的函数。

```cpp
class Entity{
public:
//虚函数
    virtual std::string GetName(){
        return "Entity";
    }

};

class Player:public Entity{
public:
private:
    std::string m_Name;
public:
    Player(const std::string& name):m_Name(name){}

//重写虚函数(override可以不写，但写了会对重写进行检查是否有对应的虚函数)
    std::string GetName() override{
        return m_Name;
    }
};

```
当虚函数=0时，称为纯虚函数，这个类就是抽象类，不能被实例化，只能被继承,子类必须重写这个函数。

```cpp
class Entity{
public:
    virtual std::string GetName() = 0;  //纯虚函数
};

class Player:public Entity{
public:
    std::string GetName() override{ //重写纯虚函数
        return "Player";
    }
};

```

### 6.9 菱形继承

菱形继承是指一个类有多个父类，而这些父类又有共同的父类，这样就会出现多次继承，导致数据冗余，内存浪费。

```cpp
class A{
public:
    int a;
};

class B:public A{
public:
    int b;
};

class C:public A{
public:
    int c;
};

//此时D类有两个A类的成员
class D:public B,public C{
public:
    int d;
};

```

解决方法：

1. 虚继承

继承的时候在可能会出现重复的类上加上virtual关键字，这样就不会出现多次继承，只会继承一次。

```cpp
class A{
public:
    int a;
};

class B:virtual public A{
public:
    int b;
};

class C:virtual public A{
public:
    int c;
};

class D:public B,public C{
public:
    int d;
};

```

### 6.10 友元函数

友元函数是指可以访问类的私有成员的函数，但不是类的成员函数。
即在类的内部声明函数为友元函数（加前缀），在类的外部定义这个函数，这个函数就可以访问类的私有成员。

```cpp

//1. 外部友元函数
class A{
private:
    int a;
public:
    A(int a):a(a){}

    friend void printA(A a);
};

void printA(A a){
    std::cout<<a.a<<std::endl;
}



//2. 友元类，即B类可以访问A类的私有成员

class A{
private:
    int a;
public:
    A(int a):a(a){}

    friend class B;
};

class B{
public:
    void printA(A a){
        std::cout<<a.a<<std::endl;
    }
};


//3. 友元成员函数，即B类的成员函数可以访问A类的私有成员

class A{
private:
    int a;
public:
    A(int a):a(a){}

    friend void B::printA(A a);
};

class B{
public:
    void printA(A a){
        std::cout<<a.a<<std::endl;
    }
};

```


<br>
<br>

---

## 七、模板

模板是一种泛型编程的方法，可以实现代码的复用。

* 定义：在要用模板的函数或类上面加上template关键字，然后在尖括号中声明模板参数，然后在函数或类中使用这个模板参数。

* 使用：在调用模板函数或类时，需要在名字后面加尖括号，尖括号中指定模板参数。
### 7.1 函数模板

函数模板是一种通用的函数，可以用于不同的数据类型。

```txt
template <typename T, int N>

T add(T N, T b){
    return N+b;
}
```

```cpp

template <typename T>

T add(T a, T b){
    return a+b;
}

int main(){
    std::cout<<add(1,2)<<std::endl;
    std::cout<<add(1.1,2.2)<<std::endl;
}

```

### 7.2 模板参数

```cpp
//N是模板参数，能使输入的数组大小不定
template <int N>
//这样是对的，因为N是当作一种替代，在编译时就会被替换成相应的值
void PrintArray(const std::array<int, N>& array){
    for(int i=0;i<N;i++){
        std::cout<<array[i]<<std::endl;
    }
}

int main(){
    std::array<int, 5> array = {1,2,3,4,5};
    PrintArray<5>(array);
}


/*
template <int N>
void PrintArray(int N) {
    for(int i = 0; i < N; i++){ 
        std::cout << i << std::endl;
    }
}

这样是错误的，因为N是当作一种替代，在编译时就会被替换成相应的值，这样就会和函数的参数冲突(如果调用时printArray<5>(5)，相当于函数参数N变成了常量5，而不是变量了
*/

```

### 7.3 类模板

类模板是一种通用的类，可以用于不同的数据类型。

```cpp

template <typename T>

class A{
public:
    T a;
    A(T a):a(a){}
};

int main(){
    A<int> a(1);
    A<std::string> b("hello");
}

```

<br>
<br>

---

## 八、lambda表达式

lambda表达式是一种匿名函数，可以用于定义函数，可以捕获外部变量。通常用于某些函数只会被调用一次的情况。

捕获是指在lambda表达式中使用外部变量。

语法：

```txt
[捕获列表]  (参数列表)  {函数体}

[捕获列表]  (参数列表)  mutable(可选)  异常声明(可选)  ->返回类型(可选)  {函数体}

捕获列表：
    []，表示不捕获任何外部变量；
    [=]，表示以值的方式捕获所有外部变量；
    [&]，表示以引用的方式捕获所有外部变量；
    [a, &b]，表示以值的方式捕获a，以引用的方式捕获b；
    [this]，表示以值的方式捕获this指针；
    [a, b]，表示以值的方式捕获a和b；
    [=, &a]，表示以引用的方式捕获所有外部变量，但是a以值的方式捕获。

```

例子:
1. 不捕获外部变量
```cpp
//lambda返回的是一个函数对象，需要用auto接收
int main(){
    auto plus = [] (int v1, int v2) -> int { return v1 + v2; };
    int sum = plus(1, 2);
    return 0;
}
```
或者：
```cpp

#include <iostream>
#include <vector>
#include <algorithm> // 为了使用std::copy_if
#include <iterator>  // 为了使用std::back_inserter

int main() {
    std::vector<int> numbers = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10};
    std::vector<int> filteredNumbers;

    // 使用 lambda 表达式过滤大于5的元素, 并将它们添加到 filteredNumbers
    std::copy_if(numbers.begin(), numbers.end(), std::back_inserter(filteredNumbers),
                 [](int x) { return x > 5; }); // Lambda 表达式

    std::cout << "Filtered Numbers: ";
    for(int num : filteredNumbers) {
        std::cout << num << " ";
    }
    std::cout << std::endl; // 输出：Filtered Numbers: 6 7 8 9 10

    return 0;
}

```

2. 捕获外部变量
```cpp
int main(){
    int a = 1;
    int b = 2;
    auto plus = [a, b] () -> int { return a + b; };
    int sum = plus();
    return 0;
}
```

<br>
<br>

---

## 九、STL

STL（Standard Template Library）是C++标准模板库，是一系列的模板类和函数，提供了通用的模板类和函数，包括算法、容器、迭代器、函数对象等。

### 9.1 容器

#### 9.1.1 vector（数组）

```txt
头文件：
#include <vector>

一维初始化：
std::vector<int> a;
std::vector<int> a(10); //初始化大小为10
std::vector<int> a(10, 1); //初始化大小为10，值为1
std::vector<int> a = {1, 2, 3, 4, 5}; //初始化为{1, 2, 3, 4, 5}

拷贝初始化：
std::vector<int> a(10,1);
std::vector<int> b(a); //拷贝初始化
std::vector<int> c = a; //拷贝初始化

二维初始化：
vector<vector<int>> a(10, vector<int>(10, 1)); //初始化大小为10*10，值为1


方法：
a.front(); //返回第一个元素
a.back(); //返回最后一个元素
a.push_back(1); //在末尾添加元素
a.pop_back(); //删除末尾元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
a.clear(); //清空
a.insert(a.begin()+1, 2); //在指定位置插入元素,即将2插入到a[1]的位置
a.erase(a.begin()+1); //删除指定位置的元素
a.erase(a.begin()+1, a.begin()+3); //删除指定范围的元素,即删除a[1]和a[2],不包括a[3]
a.resize(10); //改变大小
a.begin(); //返回指向第一个元素的迭代器
a.end(); //返回指向最后一个元素的下一个位置的迭代器
std::sort(a.begin(), a.end()); //排序


访问：
    下标访问：
        a[1]; //访问第二个元素

    迭代器访问：
        vector<int>::iterator it;
        for(it = a.begin(); it != a.end(); it++){
            std::cout<<*it<<std::endl;
        }
```

#### 9.1.2 stack（栈）

```txt
头文件：
#include <stack>

初始化：
std::stack<int> a;

方法：
a.push(1); //入栈
a.pop(); //出栈
a.top(); //返回栈顶元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
```

#### 9.1.3 queue（队列）

```txt
头文件：
#include <queue>

初始化：
std::queue<int> a;

方法：
a.push(1); //入队
a.pop(); //出队
a.front(); //返回队首元素
a.back(); //返回队尾元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
```

#### 9.1.4 deque(双端队列)

```txt
头文件：
#include <deque>

初始化：
std::deque<int> a;

方法：
a.push_back(1); //在末尾添加元素
a.pop_back(); //删除末尾元素
a.push_front(1); //在头部添加元素
a.pop_front(); //删除头部元素
a.front(); //返回第一个元素
a.back(); //返回最后一个元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
a.clear(); //清空
a.insert(a.begin()+1, 2); //在指定位置插入元素,即将2插入到a[1]的位置
a.erase(a.begin()+1); //删除指定位置的元素
a.erase(a.begin()+1, a.begin()+3); //删除指定范围的元素,即删除a[1]和a[2],不包括a[3]
a.resize(10); //改变大小
a.begin(); //返回指向第一个元素的迭代器
a.end(); //返回指向最后一个元素的下一个位置的迭代器
std::sort(a.begin(), a.end()); //排序
```

#### 9.1.5 list（链表）

```txt
头文件：
#include <list>

初始化：
std::list<int> a;

方法：
a.push_back(1); //在末尾添加元素
a.pop_back(); //删除末尾元素
a.push_front(1); //在头部添加元素
a.pop_front(); //删除头部元素
a.front(); //返回第一个元素
a.back(); //返回最后一个元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
a.clear(); //清空
a.insert(a.begin()+1, 2); //在指定位置插入元素,即将2插入到a[1]的位置
a.erase(a.begin()+1); //删除指定位置的元素
a.erase(a.begin()+1, a.begin()+3); //删除指定范围的元素,即删除a[1]和a[2],不包括a[3]
a.resize(10); //改变大小
a.begin(); //返回指向第一个元素的迭代器
a.end(); //返回指向最后一个元素的下一个位置的迭代器
std::sort(a.begin(), a.end()); //排序
```

#### 9.1.6 map（映射）

map是一种键值对的容器，可以通过键来访问值。

```txt
头文件：
#include <map>

初始化：
std::map<int, std::string> a;

方法：
a.insert(std::pair<int, std::string>(1, "a")); //插入元素
a.erase(1); //删除元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
a.clear(); //清空
a.begin(); //返回指向第一个元素的迭代器
a.end(); //返回指向最后一个元素的下一个位置的迭代器
a.find(1); //查找元素，返回指向该元素的迭代器
```

例子：

```cpp
std::map<int, std::string> a;
a.insert(std::pair<int, std::string>(1, "a"));
a.insert(std::pair<int, std::string>(2, "b"));
a.insert(std::pair<int, std::string>(3, "c"));

std::map<int, std::string>::iterator it;
for(it = a.begin(); it != a.end(); it++){
    std::cout<<it->first<<" "<<it->second<<std::endl;
}

std::map<int, std::string>::iterator it = a.find(1);
if(it != a.end()){
    std::cout<<it->first<<" "<<it->second<<std::endl;
}
```

#### 9.1.7 set（集合）

集合是一种不包含重复元素的容器。
```txt
头文件：
#include <set>

初始化：
std::set<int> a;

方法：
a.insert(1); //插入元素
a.erase(1); //删除元素
a.size(); //返回元素个数
a.empty(); //判断是否为空
a.clear(); //清空
a.begin(); //返回指向第一个元素的迭代器
a.end(); //返回指向最后一个元素的下一个位置的迭代器
a.find(1); //查找元素，返回指向该元素的迭代器
```

#### 9.1.8 string（字符串）

```txt
头文件：
#include <string>

初始化：
std::string a;

方法：
a.size(); //返回字符串长度
a.empty(); //判断是否为空
a.clear(); //清空
a.insert(1, "a"); //在指定位置插入字符串
a.erase(1); //删除指定位置的字符
a.erase(1, 3); //删除指定范围的字符
a.find("a"); //查找字符串，返回指向该字符串的迭代器
a.substr(1, 3); //返回指定范围的子字符串
a.begin(); //返回指向第一个字符的迭代器
a.end(); //返回指向最后一个字符的下一个位置的迭代器(注意！：是最后一个字符的下一个位置)
```

#### 9.1.9 array（数组）

```txt
头文件：
#include <array>

初始化：
std::array<int, 5> a;

方法：
a.size(); //返回数组长度
a.empty(); //判断是否为空
a.fill(1); //填充数组
a.begin(); //返回指向第一个元素的迭代器
a.end(); //返回指向最后一个元素的下一个位置的迭代器
```

### 9.2 迭代器

迭代器是一种指针，用于遍历容器中的元素。

```cpp
std::vector<int> a = {1, 2, 3, 4, 5};
std::vector<int>::iterator it;
for(it = a.begin(); it != a.end(); it++){
    std::cout<<*it<<std::endl;
}
```

---

## 附录：C++ 异常处理（整理自旧系列）

## 一、c++异常

### 1. 异常简介

C++异常是一种在程序运行过程中发生的意外或错误情况，例如除以零、数组越界、内存不足等。当异常发生时，程序的正常执行流程会被中断，转而执行一段专门用于处理异常的代码，称为异常处理器。异常处理器可以恢复程序的状态，继续执行后续的代码，或者终止程序并报告错误信息。

C++提供了一套异常处理机制，包括以下几个关键字：

- throw：用于抛出一个异常，可以是任意类型的表达式，例如`throw 0`; `throw "error"`; `throw std::runtime_error("invalid input")`;
- try：用于定义一个可能抛出异常的代码块，例如
```c++
try { 
    int x = 10 / 0; 
} 
catch (...) { 
    std::cout << "division by zero\n"; 
}
```
- catch：用于捕获一个特定类型或所有类型的异常，并执行相应的处理代码，您可以指定想要捕捉的异常类型，这是由 catch 关键字后的括号内的异常声明决定的,一般来说，throw什么类型的异常则要用同类型的catch参数来捕捉。例如
```c++
#include <iostream>
using namespace std;
double division(int a, int b)
{
    if( b == 0 )
    {
        throw "Division by zero condition!";
    }
    return (a/b);
}
int main ()
{
    int x = 50;
    int y = 0;
    double z = 0;
    try {
        z = division(x, y);
        cout << z << endl;
    }catch (const char* msg) {
        cerr << msg << endl;
    }
return 0;
}
//由于我们抛出了一个类型为 const char* 的异常，因此，当捕获该异常时，我们必须在 catch 块中使用 const char*。
```
可以一个try用多个catch来捕捉，只不过前面的捕捉范围要比后面的小。
- noexcept：用于指定一个函数是否保证不抛出异常，例如void foo() noexcept; void bar() noexcept(false);

### 2.异常规则

* throw抛出的异常类型与catch抓取的异常类型要一致；

* throw抛出的异常类型可以是子类对象，catch可以是父类对象；

* catch块的参数推荐采用地址传递而不是值传递，不仅可以提高效率，还可以利用对象的多态性。另外，派生类的异常捕获要放到父类异常扑获的前面，否则，派生类的异常无法被扑获；

* 如果使用catch参数中，使用基类捕获派生类对象，一定要使用传递引用的方式，例如catch (exception &e)；

* 异常是通过抛出对象而引发的，该对象的类型决定了应该激活哪个处理代码；

* 被选中的处理代码是调用链中与该对象类型匹配且离抛出异常位置最近的那一个；

* 在try的语句块内声明的变量在外部是不可以访问的，即使是在catch子句内也不可以访问；

* 栈展开会沿着嵌套函数的调用链不断查找，直到找到了已抛出的异常匹配的catch子句。如果抛出的异常一直没有函数捕获(catch)，则会一直上传到c++运行系统那里，导致整个程序的终止。

### 3. c++类
下面是c++类中常见的异常：

| 类名                       | 描述                                             |
| -------------------------- | ------------------------------------------------ |
| `Exception`                | 基本异常类，用作其他异常类的基类。               |
| `LogicError`               | 逻辑错误的异常，由程序逻辑引起。                 |
| `RuntimeError`             | 运行时错误的异常，通常由运行时环境引起。         |
| `OutOfBoundsException`     | 超出边界的异常，用于数组或容器访问超出范围。     |
| `NullPointerException`     | 空指针异常，当使用空指针时抛出。                 |
| `InvalidArgumentException` | 无效参数异常，当传递无效参数给函数或方法时抛出。 |
| `FileException`            | 文件异常，当文件操作失败时抛出。                 |
| `NetworkException`         | 网络异常，当网络操作失败时抛出。                 |


### 4. 自定义异常

您可以通过继承和重载 exception 类来定义新的异常。下面的实例演示了如何使用 std::exception 类来实现自己的异常：
```c++
#include <iostream>
#include <exception>

// 自定义异常类，继承自std::exception基类
class MyException : public std::exception
{
public:
    // 构造函数，使用传入的错误消息初始化异常对象
    MyException(const char* message) : m_message(message) {}

    // 重写what()函数，返回错误消息
    const char* what() const noexcept override  //noexcept关键字表示该函数不会引发异常。override关键字用于告诉编译器，what()函数是对基类std::exception中的虚函数进行重写。这样做可以帮助确保函数签名与基类中声明的虚函数相匹配。
    {
        return m_message;
    }

private:
    const char* m_message;  // 错误消息
};

// 自定义除数为零异常类
class DivideByZeroException : public MyException
{
public:
    // 构造函数，调用基类构造函数并传入错误消息
    DivideByZeroException() : MyException("除数不能为零！") {}
};

// 自定义索引越界异常类
class IndexOutOfBoundsException : public MyException
{
public:
    // 构造函数，调用基类构造函数并传入错误消息
    IndexOutOfBoundsException() : MyException("索引越界！") {}
};

int main()
{
    try
    {
        int divisor = 0;
        if (divisor == 0)
        {
            throw DivideByZeroException();  // 抛出除数为零异常
        }

        int arr[] = {1, 2, 3};
        int index = 5;
        if (index < 0 || index >= sizeof(arr) / sizeof(arr[0]))
        {
            throw IndexOutOfBoundsException();  // 抛出索引越界异常
        }
    }
    catch (const MyException& ex)
    {
        std::cout << "捕获到异常: " << ex.what() << std::endl;
    }

    return 0;
}

```

<br>
<br>

---

## 二、转换函数

c++转换函数是一种特殊的成员函数，它可以将一个类的对象转换为另一种类型的值。转换函数的一般形式如下：
```tex
operator 类型名()
{
    // 转换操作
}

```

其中，operator是关键字，类型名是要转换的目标类型，没有参数和返回类型。转换函数必须定义在类的内部，不能是静态的或常量的。转换函数可以被显式或隐式地调用，例如：

```c++
#include <iostream>

using namespace std;

class subclass;

class Base{
private:
    int x;
public:
    Base(int x){
        this->x = x;
    }
    operator subclass();
};

class subclass:public Base{
private:
    int x;
public:
    subclass(int x):x(x),Base(x){}
    friend ostream &operator <<(ostream &out, const subclass &obj){
        out << obj.x;
        return out;
    }
};

Base::operator subclass(){
    return x;
}

int main(){
    subclass a(10);
    Base b(6);
    a = b;
    cout << a << endl;
    return 0;
}

```

上面的代码有两个注意点。一个是b=a是调用了Base的转换函数，实际b是个Base的int成员。

另一个是a=6过程中，a是一个subclass的对象，而不是一个基本类型的变量。当你给a赋值为6时，实际上是调用了subclass的构造函数，创建了一个新的subclass对象，并用它替换了原来的a。


C++标准库中提供了一些用于类型转换的标准转换函数。这些函数可以方便地进行常见的类型转换操作。以下是几个常用的标准转换函数：
- `static_cast`: 用于执行静态类型转换，将一个表达式转换为指定类型。

    ```cpp
    int num = 10;
    double result = static_cast<double>(num);  // 将整数 num 转换为双精度浮点数

    void* ptr = static_cast<void*>(&num);  // 将指向整数 num 的指针转换为 void* 类型
    ```
- `dynamic_cast`: 用于执行动态类型转换，在类层次结构中进行多态类型的转换。

    ```cpp
    class Base {
        virtual void foo() {}
    };

    class Derived : public Base {};

    Base* basePtr = new Derived();
    Derived* derivedPtr = dynamic_cast<Derived*>(basePtr);  // 将基类指针转换为派生类指针
    ```
- `const_cast`: 用于移除变量的 `const` 修饰符或 `volatile` 修饰符。

    ```cpp
    const int num = 10;
    int* ptr = const_cast<int*>(&num);  // 移除 num 的 const 修饰符，ptr 可以修改 num 的值

    const int& ref = num;
    int& ref2 = const_cast<int&>(ref);  // 移除 ref 的 const 修饰符，ref2 可以修改 num 的值
    ```
- `reinterpret_cast`: 用于执行底层的重新解释转换。

    ```cpp
    int num = 10;
    char* charPtr = reinterpret_cast<char*>(&num);  // 将整数 num 的地址转换为字符指针

    int* intPtr = reinterpret_cast<int*>(charPtr);  // 将字符指针转换为整数指针
    ```

<br>
<br>

---
