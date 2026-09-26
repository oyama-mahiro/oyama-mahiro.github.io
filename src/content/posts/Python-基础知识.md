---
title: "[Python] 基础知识"
published: 2023-06-07
tags: [Python, 基础, 可视化]
category: Python
draft: false
---
# <font color=green>python学习-基础知识</font>



## 一、python数据类型

[python官方文档](https://docs.python.org/zh-cn/)

### 1.1 变量

&emsp;&emsp;Python 3 的变量名可以包含汉字等 Unicode 字母，不能有空格，也不能以数字开头。`message_1` 合法，`1_message` 不合法。名字区分大小写。下面的例子按 Python 3 写，`print` 是函数，要加括号。

&emsp;&emsp;变量名区分大小写。

```python
#定义变量
message = "Hello Python world!"
#同时给多个变量赋值
x,y,z = 1, 2, 3
#打印变量
print(message)
#全局变量
global a
```
python中没有常量的概念，但是可以将变量名全部大写来表示常量。

**<font color=red>注：python3后支持中文变量名，是utf-8编码</font>**

<br>

### 1.2 字符串

上面代码中，message变量所关联的值被称为字符串，即一系列字符。在Python中，用引号括起的都是字符串，其中的引号可以是单引号，也可以是双引号。在打印时，如果有多个引号，可以使用不同的引号或者转义字符\来消除引号的歧义。

#### 字符串格式
```python
#单引号
message = 'I told my friend, "Python is my favorite language!"'
print(message)
#双引号
message = "The language 'Python' is named after Monty Python, not the snake."
print(message)
#转义字符
message = 'One of Python\'s strengths is its diverse community.'
print(message)
```
注：python是每行一条语句，如果一行语句太长，可以使用反斜杠\来换行，也可以使用括号()来换行。

#### 字符串换行写一句

```python
#反斜杠换行
message = '你好\
世界'
print(message)
#括号换行
message = ("你好"
        "世界")
print(message)
```

```tex
结果：
你好世界
你好世界
```

#### 字符串一句换行写
如果想要在一行中实现换行，可以使用\n来实现。

```python
#三引号换行
message = """你好
世界"""
print(message)
#\n换行
print("abc\n123")
```


```tex
结果：

你好
世界
abc
123
```

#### 字符串拼接

除了使用+号拼接字符串，还可以使用f字符串拼接（3.5版本之前用format()方法）。

```python
first_name = "ada"
last_name = "lovelace"
#使用+号拼接字符串
full_name = first_name + "+" + last_name
print(full_name)
#使用format()方法拼接字符串
full_name = "{}+{}".format(first_name,last_name)
print(full_name)
#使用f字符串拼接字符串
full_name = f"{first_name.title()}+{last_name}"
print(full_name)


#在f字符串的变量后面使用:代表域宽
#可以用<来指定左对齐，>来指定右对齐，^来指定居中对齐。默认字符串左对齐，数字右对齐

#域宽为10，左对齐
print(f"{first_name.title():>10}+{last_name}")



```
```tex
结果：
ada+lovelace
ada+lovelace
Ada+lovelace
```
**注：空白符可以用\t来表示制表符，效果为一个tab键的距离。**

#### 字符串变化

```python
name = "ada lovelace"
#首字母大写
print(name.title())
#全部大写
print(name.upper())
#全部小写
print(name.lower())
#删除空白（末尾的空白）
print(name.rstrip())
#删除空白（开头的空白）
print(name.lstrip())
#删除空白（两端的空白）
print(name.strip())
#字符串编码
print(name.encode(encoding="utf-8")) #string->bytes
#字符串解码
print(name.encode(encoding="utf-8").decode(encoding="utf-8")) #bytes->string
```
```tex
结果：
  Ada Lovelace
  ADA LOVELACE
  ada lovelace
  ada lovelace
```
<br>

### 1.3 数据类型
&emsp;&emsp;Python中数据类型是指变量所指的内存中对象的类型。Python中常见的数据类型有六种，分别是：

- Number（数字）：包括int（整型）、float（浮点型）、bool（布尔型）和complex（复数）四种子类型。
- String（字符串）：用单引号或双引号括起来的一系列字符，可以用索引、切片和加法等操作进行处理。
- List（列表）：用方括号括起来的一组有序的数据项，可以包含不同类型的元素，支持增删改查等操作。
- Tuple（元组）：用圆括号括起来的一组有序的数据项，与列表类似，但是元素不可修改，一旦创建就不能改变。
- Dictionary（字典）：用花括号括起来的一组键值对，每个键对应一个值，可以通过键来访问值，支持增删改查等操作。
- Set（集合）：用花括号括起来的一组无序且不重复的数据项，可以进行交并差等集合运算。

<br>

### 1.4 数据类型转换
&emsp;&emsp;Python中有两种数据类型转换：隐式类型转换和显式类型转换。

&emsp;&emsp;隐式类型转换是指Python在运算或函数调用时，根据需要自动将一种数据类型转换为另一种数据类型，不需要程序员干预。例如，在加法运算中，如果两个操作数的类型不同，Python会将较低的数据类型转换为较高的数据类型，以避免数据丢失。例如：

```python
a = 10 # a是整数
b = 3.14 # b是浮点数
c = a + b # c是浮点数，因为a被隐式转换为浮点数
print(c) # 输出13.14
```

&emsp;&emsp;显式类型转换是指程序员根据需要，使用内置的函数将一种数据类型强制转换为另一种数据类型。例如，int()函数可以将一个浮点数或一个字符串转换为一个整数，float()函数可以将一个整数或一个字符串转换为一个浮点数，str()函数可以将一个数字或其他对象转换为一个字符串。

<br>

### 1.5 运算符
Python中的运算法则是指在进行算术运算、比较运算、逻辑运算等时，遵循的优先级和结合性规则。Python中的运算法则与数学中的运算法则基本一致，但也有一些特殊的情况。以下是Python中常见的运算法则：

- 算术运算符：+ - * / // % ** 分别表示加法、减法、乘法、除法、整除、取余和幂运算。其中，\*\*具有最高的优先级，其次是* / // %，最后是+ -。同级别的运算符按照从左到右的顺序结合。
- 比较运算符：> < >= <= == != 分别表示大于、小于、大于等于、小于等于、等于和不等于。比较运算符具有相同的优先级，并且按照从左到右的顺序结合。比较运算符可以进行链式比较，例如a < b < c表示a小于b并且b小于c。
- 逻辑运算符：and or not 分别表示与、或和非。其中，not具有最高的优先级，其次是and，最后是or。同级别的运算符按照从左到右的顺序结合。逻辑运算符可以进行短路求值，即如果第一个操作数已经能够确定结果，就不会再计算第二个操作数。
- 赋值运算符：= += -= *= /= //= %= **= 分别表示赋值、加法赋值、减法赋值、乘法赋值、除法赋值、整除赋值、取余赋值和幂运算赋值。赋值运算符具有相同的优先级，并且按照从右到左的顺序结合。赋值运算符可以进行链式赋值，例如a = b = c表示将c的值同时赋给a和b。
- 位运算符：& | ^ ~ << >> 分别表示按位与、按位或、按位异或、按位取反、左移和右移。其中，~具有最高的优先级，其次是<< >>，然后是&，再然后是^，最后是|。同级别的运算符按照从左到右的顺序结合。
- 成员运算符：in ，not in 分别表示判断一个对象是否在另一个对象中或不在另一个对象中。成员运算符具有相同的优先级，并且按照从左到右的顺序结合。
- 身份运算符：is ，is not 分别表示判断两个对象是否是同一个对象或不是同一个对象。身份运算符具有相同的优先级，并且按照从左到右的顺序结合。
- 括号：() [] {} 分别表示圆括号、方括号和花括号。括号可以改变运算的优先级和结合性，括号内的表达式具有最高的优先级，并且按照从内到外的顺序计算。

<br>

### 1.6 列表

&emsp;&emsp;列表的效果和其它语言的数组差不多，但是列表可以存储任意类型的数据，而且可以随意增删改查，可内嵌列表。列表用方括号[]来表示，索引从0开始，其中的元素用逗号分隔。
```python
#定义列表
list1 = [1,2,"a","b",3.14,True]
list2 = [3,4,"c",list1]

print(list2[3][2])

list3 = []
#数值列表range(<起始>,<结束>,<步长>)
for i in range(1,10,2):
    list3.append(i)
#或者list3 = list(range(1,10,2))
print(list3)
```
```tex
结果：

a
[1, 3, 5, 7, 9]

```

#### 列表操作

```python
list1 = [1,2,"a","b",3.14,True]
print(list1)
#在列表末尾插入元素
list1.append("c")
print(list1)
#在指定位置插入元素
list1.insert(2,"d")
print(list1)

#删除列表末尾的元素
list1.pop()
print(list1)
#删除指定位置的元素
list1.pop(2)
print(list1)
#或del list1[2]


#注：pop会返回被删除的元素，del不会返回被删除的元素

#根据值删除元素
list1.remove("b")
print(list1)

```

```tex
结果：

[1, 2, 'a', 'b', 3.14, True, 'c']
[1, 2, 'd', 'a', 'b', 3.14, True, 'c']
[1, 2, 'd', 'a', 'b', 3.14, True, 'c']
[1, 2, 'd', 'a', 'b', 3.14, True]
[1, 2, 'a', 'b', 3.14, True]
[1, 2, 'a', 3.14, True]

```

#### 列表排序

```python
list1 = [1,2,5,3,4]
#临时性排序
print(sorted(list1))
print(list1)
#永久性排序
list1.sort()
print(list1)
#永久性倒序
list1.reverse()
#或者 list1.sort(reverse=True)
print(list1)
#获取列表长度(即元素个数)
print(len(list1)) #也可以用来获取字符串长度
```

```tex
结果：

[1, 2, 3, 4, 5]
[1, 2, 5, 3, 4]
[1, 2, 3, 4, 5]
[5, 4, 3, 2, 1]
5
```

#### 列表遍历

python中列表用for循环遍历，for循环的范围是根据缩进来判断的，变量名是自取的，用来表示每次取到的元素。

> for <变量> in <列表名>:
>   <语句块>

```python
list1 = [1,2,3,4,5]
for i in list1:
    print(i)
```

```tex
结果：

1
2
3
4
5
```

#### 数值列表统计
```python
list1 = [1,2,3,4,5]
#最大值
print(max(list1))
#最小值
print(min(list1))
#求和
print(sum(list1))
```

```tex
结果：

5
1
15
```

#### 列表切片

**注意：列表切片是指从列表中取出一部分元素，切片的范围是左闭右开的，即包含左边的索引，不包含右边的索引。**

```python
list1 = [1,2,3,4,5]

#切片
print(list1[0:3])
#从头开始切片
print(list1[:3])
#到末尾结束切片
print(list1[3:])
#倒数切片
print(list1[-3:])
#步长切片
print(list1[0:5:2])
#倒序切片
print(list1[::-1])
```

```tex
结果：

[1, 2, 3]
[1, 2, 3]
[4, 5]
[3, 4, 5]
[1, 3, 5]
[5, 4, 3, 2, 1]
```
#### 列表复制

列表的复制有两种形式，一种是两个变量指向同一个列表，一种是两个变量指向不同的列表。

```python
list1 = [1,2,3,4,5]
#两个变量指向同一个列表
list2 = list1
list1.append(6) //list2也会增加一个元素
#两个变量指向不同的列表
list3 = list1.copy()
list3.append(7) //list2不会增加一个元素
#或 list3 = list1[:]
print(list1)
print(list2)
print(list3)
```

```tex
结果：

[1, 2, 3, 4, 5, 6]
[1, 2, 3, 4, 5, 6]
[1, 2, 3, 4, 5, 6, 7]
```


<br>

### 1.7 元组

&emsp;&emsp;元组和列表类似，但是元组的元素不可修改，一旦创建就不能改变。元组用圆括号()来表示，索引从0开始，其中的元素用逗号分隔。

&emsp;&emsp;元组的元素不可修改，但是可以给元组变量重新赋值。

```python
#定义元组
tuple1 = (1,2,"a","b",3.14,True)
tuple2 = (3,4,"c",tuple1)

print(tuple2[3][2])

#数值元组range(<起始>,<结束>,<步长>)
tuple4 = tuple(range(1,10,2))
print(tuple4)

#元组变量重新赋值
tuple4 = ("a","b")
print(tuple4)
```
```tex
结果：

a
(1, 3, 5, 7, 9)
('a', 'b')
```

<br>

### 1.8 字典

&emsp;&emsp;字典是一种键值对的数据结构，用花括号{}来表示，其中的键和值用冒号:分隔，键值对之间用逗号分隔。字典中的键必须是不可变的数据类型，如数字、字符串、元组等（列表就不能作为键，元组可以），而值可以是任意类型的数据，如数字、字符串、列表、元组、字典等。字典中的键必须是唯一的，而值可以重复。

&emsp;&emsp;不写键的字典称为集合，集合中的元素也是唯一的。


```python
#定义字典
dict1 = {
    "a":1,  #可以换行定义
    ("b",1):2,
    ("b",2):3,
    "c":4,
    "d":5 if 1>2 else 6, #可以用三元表达式
    }

#访问字典中的值
print(dict1[("b",1)])

#修改字典中的值
dict1[("b",1)] = 5 #添加一样，没有对应键值就是添加

#删除字典中的键值对，没有对应键值就报错
del dict1[("b",1)]

#判断键是否在字典中
print("a" in dict1)

#获取字典中的键值对个数
print(len(dict1))


```
#### 字典遍历

```python
dict1 = {
    "a":1,  #可以换行定义
    ("b",1):2,
    ("b",2):3,
    "c":4,
    }

#遍历键函数
dict1.keys()
#遍历值函数
dict1.values()
#遍历键值对函数
dict1.items()

#条件遍历，变量有两个的原因是因为items()函数返回的是键值对，第一个变量是键，第二个变量是值
for key,value in dict1.items():
    if key == "a":
        print(key,value)

#按特定顺序遍历(元素必须相同)
for val in sorted(dict1.vlaues()):
    print(val)
```

<br>
<br>

---

## 二、python基本语句

### 2.1 用户输入

&emsp;&emsp;python中使用input()函数来获取用户输入，input()函数的返回值是字符串，如果需要转换成其他类型，需要使用int()、float()等函数。

```python
#获取用户输入
message = input("请输入：")
print(message)
#转换成整型
num = int(input("请输入："))
print(num)

#多输入,split是分隔符，可以是空格，逗号等
a,b = input("请输入：").split(" ")
```

### 2.2 if语句

&emsp;&emsp;if中可以嵌套，python会根据缩进来判断是哪一个if循环。python中没有switch语句。
```python
if <条件>:
    <语句块>
elif <条件>:
    <语句块>
else:
    <语句块>


#比如判断三个数中的最大值
x=1
y=2
z=3
if x>=y and x>=z: #逻辑判断 and与 or或 not非
    print("x")
elif y>=x and y>=z:
    print("y")
else:
    print("z")

#列表中的元素也可以用in和not in来判断
list1 = [1,2,3,4,5]
if 1 in list1:
    print("1在列表中")
if 6 not in list1:
    print("6不在列表中")

#在if 语句中将列表名用作条件表达式时，列表中没有元素时返回False，否则返回True。
list2 = []
if list2:
    print("列表不为空")
else:
    print("列表为空")
```
**注：空列表，空字符串，空字典，空元组，空集合，0，None都是False。**

### 2.3 while语句

&emsp;&emsp;while语句用来判断循环条件。可以使用break和continue

```python
while <条件>:
    <语句块>

#删除列表中的所有cat
pets = ['dog', 'cat', 'dog', 'goldfish', 'cat', 'rabbit', 'cat']
print(pets)

while 'cat' in pets:
    pets.remove('cat')
print(pets)

```

### 2.4 for语句

&emsp;&emsp;for语句用来遍历序列，序列可以是列表、元组、字符串等。但如果涉及修改序列的操作，最好使用while语句。

```python
for <变量> in <序列>:
    <语句块>

#循环特定次数
for i in range(1,10,2):
    print(i)

#遍历列表
list1 = [1,2,3,4,5]
for i in list1:
    print(i)

#遍历字典
dict1 = {
    "a":1,  #可以换行定义
    ("b",1):2,
    ("b",2):3,
    "c":4,
    }

for key,value in dict1.items():
    print(key,value)

```

<br>
<br>

---

## 三、python函数

### 3.1 函数定义

&emsp;&emsp;函数是一段可以重复调用的代码块，可以接受参数，也可以返回值。

**参数的传递是引用传递。**

函数的定义格式如下：

```python
def <函数名>(<参数列表>):
    <语句块>
    return <返回值>
```
#### 参数的传递

- 位置实参：按照参数的位置，依次传递参数，这是最普通的方式。例如：
```python
# 定义一个函数，有两个形参a和b
def func(a, b):
    # 在函数内部打印a和b的值
    print(a, b)

# 调用函数，按照位置传递两个实参1和2
func(1, 2)
# 输出结果是：1 2
```
- 关键字实参：如果不想严格按照顺序传递参数，也可以按关键字传递。例如：
```python
# 定义一个函数，有两个形参a和b
def func(a, b):
    # 在函数内部打印a和b的值
    print(a, b)

# 调用函数，按照关键字传递两个实参1和2，指定参数名
func(b=2, a=1)
# 输出结果是：1 2
```
- 缺省参数：定义函数时，可以给某个参数赋值一个默认值，具有默认值的参数就叫做缺省参数。调用函数时，如果没有传入缺省参数的值，则在函数内部使用参数默认值。例如：
```python
# 定义一个函数，有两个形参a和b，其中b是缺省参数，默认值为2
def func(a, b=2):
    # 在函数内部打印a和b的值
    print(a, b)

# 调用函数，只传入一个实参1，省略了缺省参数b的值
func(1)
# 输出结果是：1 2
```
- 多值参数：当函数需要处理的参数个数不确定时，可使用多值参数。形参名中*args表示接收到的值放入args组元中，形参名中**kwargs表示接收的值放入字典中。例如：
```python
# 定义一个函数，有两个多值形参*args和**kwargs
def func(*args, **kwargs):
    # 在函数内部打印*args和**kwargs的值
    print(args, kwargs)

# 调用函数，传入任意个数和类型的实参
func(1, 2, a=3, b=4)
# 输出结果是：(1, 2) {'a': 3, 'b': 4}
```
- 拆包：就是多值传参，参数用一个元组变量或字典变量作为实参传递给多值形参，在变量前加*或**。例如：
```python
# 定义一个函数，有两个多值形参*args和**kwargs
def func(*args, **kwargs):
    # 在函数内部打印*args和**kwargs的值
    print(args, kwargs)

# 定义一个元组变量nums和一个字典变量info
nums = (1, 2)
info = {'a': 3, 'b': 4}

# 调用函数，使用拆包的方式传入元组或字典变量
func(*nums, **info)
# 输出结果是：(1, 2) {'a': 3, 'b': 4}
```

<br>
<br>

---

## 四、python模块、包

&emsp;&emsp;模块导入就是将一个python文件中的代码导入到另一个python文件中，这样就可以在另一个文件中使用这个文件中的代码。

```python
#导入整个模块，使用时需要在前面加 模块名.函数名
import <模块名>
#导入模块中的函数
from <模块名> import <函数名>
#导入模块中的所有函数(使用时不需要在前面加模块名)
from <模块名> import *
#导入模块中的函数并指定别名
from <模块名> import <函数名> as <别名>
#导入模块中的所有函数并指定别名
from <模块名> import * as <别名>
#导入模块中的类
from <模块名> import <类名>

#导入的是模块的时候，调用函数时需要加上模块名,如：LED.led_on()
```
<br>
<br>

---

&emsp;&emsp;包是一个包含多个模块的特殊目录，目录下有一个特殊的文件`__init__.py`，包名就是目录名。包中的模块可以使用`from 包名 import 模块名`来导入。
```python
#导入包中的模块
from <包名> import <模块名>
#导入包中的模块并指定别名
from <包名> import <模块名> as <别名>
#导入包中的模块的函数
from <包名>.<模块名> import <函数名>
#导入包的指定模块中的所有函数
from <包名>.<模块名> import *
...
```

&emsp;&emsp;在`__init__.py`这个文件中可以使用`__all__`来指定当模块名是*的时候导入的模块，如果不指定则默认导入所有模块。

```python
#只导入model1
__all__ = ["model1"]
```

## 五、python类

### 5.1 类的定义

python中创建类使用的是`class`关键字，类名的首字母大写。类的构造函数是`__init__`，**类中所有函数的第一个参数必须是`self`，`self`表示类的实例对象。**

**python中可以不需要提前创建成员变量，要创建成员变量只需要使用`self.变量名`来创建即可。**


创建对象时就用类名加括号，括号中的参数是`__init__`函数的参数。

```python
class Cat:
    #共有
    name = "三花猫"
    #私有
    __age = 3
    #保护属性在类外部可以访问，但是不能修改
    _color = "white"

    def __init__(self,name,age):
        self.name = name
        self.age = age
    def show(self):
        print(f"cat's name is {self.name},age is {self.age}")

cat = Cat("三花猫",3)
cat.show()
```

### 5.2 类的继承

&emsp;&emsp;python中使用`class 子类名(父类名)`来表示继承关系，子类可以继承父类的所有属性和方法，`object`类是所有的父类。

&emsp;&emsp;当子类中定义了与父类同名的方法时，子类的方法会覆盖父类的方法。

&emsp;&emsp;如果子类中需要调用父类的方法，可以使用`super().方法名()`来调用父类的方法。比如子类在__init__方法中调用父类的__init__方法就在里面加上super()._init__()。

```python
class Animal:
    def __init__(self,name,age):
        self.name = name
        self.age = age
    def show(self):
        print(f"animal's name is {self.name},age is {self.age}")

class Cat(Animal):
    def __init__(self,name,age,color):
        super().__init__(name,age)
        self.color = color
    def show(self):
        print(f"cat's name is {self.name},age is {self.age},color is {self.color}")

```


### 5.2 类的多态

&emsp;&emsp;python中的多态是指子类可以重写父类的方法，从而实现不同的功能。

<br>
<br>

---

## 六、python文件

### 6.1 文件的打开

&emsp;&emsp;python中使用`open()`函数来打开文件，`open()`函数的第一个参数是文件名，第二个参数是打开文件的模式，第三个参数是编码格式（可忽略）。

&emsp;&emsp;文件的打开模式有以下几种：

- r：只读模式，如果文件不存在，会报错。
- w：只写模式，如果文件不存在，会创建文件，如果文件存在，会覆盖文件。
- a：追加模式，如果文件不存在，会创建文件，如果文件存在，会在文件末尾追加内容。
- r+：读写模式，如果文件不存在，会报错。
- w+：读写模式，如果文件不存在，会创建文件，如果文件存在，**会覆盖文件**。
- a+：读写模式，如果文件不存在，会创建文件，如果文件存在，会在文件末尾追加内容。

### 6.2 文件的读写

&emsp;&emsp;文件的读写使用`read()`和`write()`函数，`read()`函数用来读取文件中的内容，`write()`函数用来向文件中写入内容。

&emsp;&emsp;`read()`函数的参数是读取的字符数，如果不指定参数，则读取整个文件。

```python
#打开文件
file = open("./test.txt","a+",encoding="utf-8")
#写入文件
file.write("hello world")
#移动文件指针到开头,不移动就看不到内容
file.seek(0,0)#参数1是偏移量，参数2是偏移位置，参数2填0表示文件开头，1表示当前位置，2表示文件末尾 
#读取文件
content = file.read()
#逐行读取文件
content = file.readline()
#读取所有行
content = file.readlines()


print(content)
#关闭文件
file.close()



#with语句可以自动关闭文件
with open("./test.txt","a+",encoding="utf-8") as file:
    file.write("hello world")
    file.seek(0)
    content = file.read()
    print(content)

```
注意：用w+模式打开文件时，如果文件存在，会**覆盖原文件**。用a+的时候不会覆盖原文件，但是每次光标都会移动到文件末尾，所以读取文件时需要用`seek`将光标移动到文件开头。


<br>
<br>

---

## 七、python异常和测试

### 7.1 异常

&emsp;&emsp;python中的异常是指程序在运行时发生的错误，如除数为0、索引超出范围、变量未定义等。python中的异常处理使用`try...except...`语句，`try`语句用来执行可能发生异常的代码，`except`语句用来处理异常。
| 异常类型 | 描述 |
| :--- | :--- |
| Exception | 常规错误的基类 |
| AssertionError | 断言语句失败 |
| AttributeError | 对象没有这个属性 |
| IndexError | 序列中没有此索引 (index) |
| KeyError | 映射中没有这个键 |
| NameError | 未声明/初始化对象 (没有属性) |
| OSError | 操作系统错误 |
| SyntaxError | Python 语法错误 |
| TypeError | 对类型无效的操作 |
| ZeroDivisionError | 除 (或取模)零 (所有数据类型) |

```python
try:               #try语句块中的代码可能会发生异常
    <语句块>
except <异常类型>: #最上面的优先级最高
    <语句块>
except <异常类型>: #可以有多个except  
    <语句块>
else:             #没有异常时执行
    <语句块>
finally:          #不管有没有异常都会执行
    <语句块>


#自定义异常
class MyError(Exception):
    def __init__(self,value):
        self.value = value #异常的描述信息
    def __str__(self):
        return self.value   
```

### 7.2 单元测试

&emsp;&emsp;python中的单元测试是指对程序中的最小可测试单元进行检查和验证，通常是对函数、类或模块进行测试。python中的单元测试使用`unittest`模块，`unittest`模块中的`TestCase`类用来创建测试用例，`TestCase`类中的`setUp()`方法用来初始化测试用例，`tearDown()`方法用来清理测试用例，`TestCase`类中的`assertEqual()`方法用来断言两个值是否相等，`assertNotEqual()`方法用来断言两个值是否不相等，`assertIn()`方法用来断言一个值是否在另一个值中，`assertNotIn()`方法用来断言一个值是否不在另一个值中。

```python
#实现代码
class Sentence:
    def __init__(self, sentence):
        self.sentence = sentence  # 句子字符串

    """返回句子中的单词列表"""
    def get_words(self):  
        return self.sentence.split(',') # 用逗号分割句子字符串并返回列表

#测试代码
import unittest
from sentence import Sentence

class SentenceTestCase(unittest.TestCase):
    """句子测试用例"""

    def setUp(self):
        """创建句子实例"""
        self.sentence = Sentence('hello,world')

    def tearDown(self):
        """删除句子实例"""
        del self.sentence

    def test_get_words(self):   #测试用例必须以test开头
        """测试句子中的单词列表"""
        words = self.sentence.get_words() 
        self.assertEqual(words, ['hello', 'world'])
    
    def test_get_words2(self):   #测试用例必须以test开头
        """测试句子中是否包含指定单词"""
        words = self.sentence.get_words()
        self.assertNotIn('hello', words)
```

&emsp;&emsp;如果要测试一个模块，可以在模块中加入如下代码，点这段左边的运行就能测试该模块，如果整体运行模块则不会执行测试代码。

```python

if __name__ == '__main__':
    <代码块>

```



<br>
<br>

---

## 八、python进程线程

### 8.1 线程

&emsp;&emsp;线程是操作系统能够进行运算调度的最小单位，它被包含在进程之中，是进程中的实际运作单位。一个进程可以由很多个线程组成，线程间共享进程的所有资源，每个线程有自己的堆栈和局部变量。线程的调度和分配由操作系统决定。  

&emsp;&emsp;python的线程是没有利用多核，因为python的线程是由操作系统调度的，而操作系统是不知道python的线程的存在的，所以python的线程是单核的。如果想要利用多核，可以使用多进程。

```python

import threading  #导入线程模块

#定义锁
lock = threading.Lock()

#定义线程函数
def thread_func1(*args): #*args表示可变参数
    #请求锁
    lock.acquire()
    print("thread1")
    #释放锁
    lock.release()


def thread_func2(*args):
    #根据锁的状态来判断是否执行
    with lock:
        print("thread2")

#创建线程
thread1 = threading.Thread(target=thread_func1,args=(1,2,3)) #target是线程函数，args是线程函数的参数
thread2 = threading.Thread(target=thread_func2,args=(4,5,6))

#启动线程
thread1.start()
thread2.start()

#等待线程结束
thread1.join()
thread2.join()

```

### 8.2 进程

&emsp;&emsp;进程是操作系统进行资源分配和调度的基本单位，是操作系统结构的基础。

&emsp;&emsp;python的多进程是利用多核的，因为python的多进程是由操作系统调度的，而操作系统是知道python的多进程的存在的，所以python的多进程是多核的。

```python
import multiprocessing #导入多进程模块

#定义进程锁
lock = multiprocessing.Lock()

#定义进程函数
def process_func1(*args):
    #请求锁
    lock.acquire()
    print("process1")
    #释放锁
    lock.release()

def process_func2(*args):
    #根据锁的状态来判断是否执行
    with lock:
        print("process2")

#创建进程
process1 = multiprocessing.Process(target=process_func1,args=(1,2,3))
process2 = multiprocessing.Process(target=process_func2,args=(4,5,6))

#启动进程
process1.start()
process2.start()

#等待进程结束
process1.join()
process2.join()

```


<br>
<br>

---

## 九、python网络编程

### 9.1 TCP

&emsp;&emsp;TCP是一种面向连接的、可靠的、基于字节流的传输层通信协议，是一种传输控制协议，是一种面向连接的协议，即传输数据之前必须先建立连接，数据传输结束后要释放连接。TCP是一种可靠的协议，即数据传输的过程中，如果出现丢包、超时等情况，TCP会自动重发数据，保证数据的可靠性。TCP是一种基于字节流的协议，即数据是以字节流的形式传输的，没有数据边界。

```python
#多线程并发TCP服务器


import socket
from threading import Thread


# 1.创建套接字
sockfd = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0)
print(type(sockfd), sockfd)

# 设置端口复用
sockfd.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)


# 2.绑定
sockfd.bind(("192.168.12.77", 7777))
print("绑定成功~~~")



def do_clinet(*args):
    connfd, client_addr = args
    print(client_addr)

    while 1:
        try:
            ret = connfd.recv(16)
            print("recv:\n", ret.decode(encoding="utf-8"))

            str1 = input("请输入:")
            connfd.send(str1.encode(encoding="utf-8"))
        except ConnectionAbortedError as ret:
            print("客户端退出~~~")
            break



while 1:
    # 3.监听
    sockfd.listen(10)
    print("listening~~~")
    # 4.接受

    connfd,client_addr = sockfd.accept()

    # 1.创建线程
    tid = Thread(target=do_clinet, args=(connfd, client_addr))

    # 2.启动
    tid.start()

```

&emsp;&emsp;python中拥有专门用于创建并发服务器的类,将类中的handle方法（每个进程/线程执行的函数）重写即可实现。


```python
from socketserver import ThreadingTCPServer, StreamRequestHandler


class LDY(StreamRequestHandler):
    # 重写handle方法 -- 客户端连接后，自动执行的函数
    def handle(self):
        print("recv:\n{}".format(self.request.recv(32).decode("utf-8")))

        self.request.sendall(b"hello")


if __name__ == "__main__":
    # 1.创建并启动服务器
    ser = ThreadingTCPServer(("0.0.0.0", 7777), LDY)
    print("服务器已启动~~~")
    # 2.永远等待连接
    ser.serve_forever()
```

### 9.2 UDP

&emsp;&emsp;UDP是一种面向无连接的、不可靠的、基于数据报的传输层通信协议，是一种用户数据报协议，是一种面向无连接的协议，即传输数据之前不需要建立连接，数据传输结束后也不需要释放连接。UDP是一种不可靠的协议，即数据传输的过程中，如果出现丢包、超时等情况，UDP不会重发数据，数据的可靠性得靠应用层来保证。UDP是一种基于数据报的协议，即数据是以数据报的形式传输的，有数据边界。

```python

from socketserver import DatagramRequestHandler, UDPServer

class LDY(DatagramRequestHandler):
    # 重写handle方法 -- 客户端连接后，自动执行的函数
    def handle(self):
        print("recv:\n{}".format(self.request[0].decode("utf-8")))

        self.request[1].sendto(b"hello", self.client_address)

if __name__ == "__main__":
    # 1.创建并启动服务器
    ser = UDPServer(("0.0.0.0", 7777), LDY)
    print("服务器已启动~~~")
    # 2.永远等待连接
    ser.serve_forever()
```
### 9.3 http

&emsp;&emsp;HTTP是一种无状态的、无连接的、基于请求/响应的应用层协议，是一种超文本传输协议，是一种无状态的协议，即每次请求都是独立的，服务器不会记录每次请求的状态，即服务器不知道当前请求是哪个用户发出的。HTTP是一种无连接的协议，即每次请求都是独立的，服务器不会记录每次请求的状态，即服务器不知道当前请求是哪个用户发出的。HTTP是一种基于请求/响应的协议，即客户端发送请求，服务器返回响应。

```python
from http.server import HTTPServer, CGIHTTPRequestHandler


# 1.创建并启动
ser = HTTPServer(("0.0.0.0", 8888), CGIHTTPRequestHandler)
print("http服务器已启动~~~")

# 2.永远等待连接
ser.serve_forever()


# 在浏览器里面,http://IP:port
```

<br>
<br>

---

## 十、python串口

```python
import serial
from serial.tools import list_ports




# 遍历当前的可用串口
ret = list_ports.comports()
if not ret:
    print("没有可用串口")
    exit()
for i in ret:
    print(i)


# 1.打开，配置串口
uart = serial.Serial(port="COM1",
                     baudrate=115200,
                     bytesize=8,
                     )


while 1:
    # 2.读写
    print("read:\n{}".format(uart.read(5).decode()))

    uart.write(b"hello")

uart.close()
```

---

## 附录 A：NumPy 简介（原「常用包」）

## 一、numpy

&emsp;&emsp;numpy是python的一个科学计算的库，提供了矩阵运算的功能，可以用来做矩阵运算，也可以用来做矩阵运算的加速，因为numpy是用C语言写的，所以运算速度很快。

&emsp;&emsp;numpy的特点：

- numpy在创建时大小固定，不可变，而python的list是可以动态改变大小的。
- numpy里面的元素都是同一种类型，而python的list里面的元素可以是不同的类型。
- numyp可以用作矩阵运算，而python的list不能用作矩阵运算。

---

## 附录 B：数据可视化笔记（原独立短文，未完成）

## 一、数据可视化介绍

&emsp;&emsp;数据可视化是数据分析的重要组成部分，数据可视化是指通过图表、地图、仪表盘等可视化手段，将数据以直观的方式展现出来。

&emsp;&emsp;数据可视化有许多的第三方包，比如：matplotlib、seaborn、pyecharts、plotly等，本文主要介绍pyecharts。

[pyecharts官方示例](https://gallery.pyecharts.org/#/README)

[pyecharts官方文档](https://pyecharts.org)

<br>
<br>

---

## 二、前提知识

### 1.JSON

&emsp;&emsp;JSON(JavaScript Object Notation) 是一种轻量级的数据交换格式，易于人阅读和编写，同时也易于机器解析和生成。

&emsp;&emsp;JSON键值对的键必须是字符串，值可以是字符串、数字、布尔值、数组、对象等。

&emsp;&emsp;C、Python、C++、Java、PHP、Go等编程语言都支持 JSON。

```tex

  {
    "sites": [
    { "name":"菜鸟教程" , "url":"www.runoob.com" }, 
    { "name":"google" , "url":"www.google.com" }, 
    { "name":"微博" , "url":"www.weibo.com" }
    ]
}

这个 sites 对象是包含 3 个站点记录（对象）的数组。
```

<br>
<br>

---

## 三、基础图表

### 1.折线图
