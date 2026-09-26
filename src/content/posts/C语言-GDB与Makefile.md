---
title: "[C语言] GDB 与 Makefile"
published: 2023-03-17
tags: [C语言, GDB, Makefile]
category: C语言
draft: false
---
# [C语言] GDB 与 Makefile

## 一、GDB 调试工具

帮助我们找出代码的问题

gcc -g 文件.c -o 程序名
gdb 程序名
gdb -p 进程号     附着到已经在跑的进程，不是 gdb 程序名 -p

r 运行
l 列出源码
b 行号或函数名   设断点
c 继续到下一个断点
p 变量           打印值
n 下一行，不进入函数
s 下一行，进入函数
d 删除断点，delete 也可以
bt 查看调用栈
q 退出 gdb


<br>
<br>

---


## 二、Makefile

makefile是一个文件，里面放的是编译的规则，可以管理多个文件

make是一个工具，用来解析我们的makefile

make会根据文件的时间戳进行编译，如果文件的时间戳没有改变，不会编译该文件，节省大量的编译时间

makefile的逻辑：

目标文件：依赖文件

​     （tab）编译语句

目标文件就是我们最终会生成的文件，要生成这个文件，会去找生成它需要的文件，就叫依赖文件，如果这个依赖文件有需要其他文件来生成，继续找它的依赖文件，直到不需要为止

```c
 1 app:list.o main.o
  2     gcc  list.o main.o -o app
  3 list.o:list.c
  4     gcc -c list.c -o list.o
  5 main.o:main.c
  6     gcc -c main.c -o main.o
  7 clean:
  8     rm main.o list.o app 

```

make clean  删除生成的文件（执行clean后面的语句）

make，默认解析当前目录下的makefile或者Makefile

make -f 指定的makefile

调用外部头文件-I 加头文件的路径

```c
 1 app:list.o main.o
  2     gcc  list.o main.o -I ./include -o app
  3 list.o:list.c
  4     gcc -c list.c -I ./include -o list.o
  5 main.o:main.c
  6     gcc -c main.c -I ./include -o main.o
  7 clean:
  8     rm main.o list.o app 
```

### makefile的变量

变量的赋值：

* =：给当前变量赋值，但是如果后面有新的赋值，把新的赋值给变量

```c
1 a=12
  2 b=$(a)
  3 a=34
  4 all:
  5     @echo $(b)
b=34
```

* :=---立即赋值,和平时的赋值一样，后面新的赋值不会改变当前值

```c
1 a=12
  2 b:=$(a)
  3 a=34
  4 all:
  5     @echo $(b)
      b=12
```

* ？=---询问赋值,询问前面有没有赋值，如果有，此次赋值无效

```c
 1 a=12
  2 b:=$(a)
  3 a?=34
  4 all:
  5     @echo $(b)
  6     echo $(a)
a=12
```

* +=：追加赋值

```c
1 a=12
  2 b:=$(a)
  3 a+=hello
  4 all:
  5     @echo $(b)
  6     echo $(a)
a=12 hello
```

>可以在语句前加@隐藏显示语句

利用变量写makefile：

```c
 1 TARGET=app //相当于代替
  2 OBJS=list.o main.o 
  3 CC=gcc
  4 OBJS2=list.c
  5 OBJS3=main.c
  6 PATH=-I ./include
  7 
  8 $(TARGET):$(OBJS)
  9     $(CC)  $(OBJS) $(PATH) -o $(TARGET)
 10 list.o:$(OBJS2)
 11     $(CC) -c $(OBJS2) $(PATH) -o list.o
 12 main.o:$(OBJS3)
 13     $(CC) -c $(OBJS3) $(PATH) -o main.o
 14 clean:
 15     rm $(OBJS) $(TARGET) 
~                            
```

特殊的变量：

>\$@---目标文件
\$^---所有依赖文件
\$<:第一个依赖文件
通配符：%

```c
 TARGET=app
  2 OBJS=list.o main.o
  3 CC=gcc
  4 OBJS2=list.c
  5 OBJS3=main.c
  6 path=-I ./include
  7 $(TARGET):$(OBJS)
  8     $(CC)  $^ $(path) -o $@
  9 %.o:%.c
 10     $(CC) -c $^ $(path) -o $@
 11 clean:
 12     rm $(TARGET) $(OBJS)
```



