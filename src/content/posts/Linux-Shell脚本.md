---
title: "[Linux] Shell 脚本"
published: 2023-03-15
tags: [Linux, Shell, 脚本]
category: Linux
draft: false
---
# [Linux] Shell 脚本

脚本是按顺序执行的命令。第一行写明解释器：

```bash
#!/bin/bash
```

运行有两种办法：`bash 脚本.sh`，或者 `chmod +x 脚本.sh` 之后 `./脚本.sh`。

Bash 默认遇到错误会继续往下跑。正式脚本建议在开头加上：

```bash
set -euo pipefail
```

`e` 是命令失败就退出，`u` 是用了没定义的变量就退出，`pipefail` 是管道中任意一段失败都算失败。

引号：

- 单引号里几乎一切都是字面量，`$变量` 不会展开
- 双引号里会展开变量，空格也会保留
- 不加引号时，空格会把一个值拆成多个词

管道 `|` 把前一条命令的标准输出交给后一条。`` `命令` `` 和 `$(命令)` 都会把命令的输出当成文本，优先用 `$()`。

```bash
echo hello    world          # 多个空格会收成一个
echo "hello    world"        # 空格保留
echo "当前目录是 $(pwd)"
```

重定向：`>` 覆盖写入，`>>` 追加。`cat > 文件` 会一直读键盘，直到 `Ctrl+D`。

通配符由 shell 展开，不是由 `rm` 自己展开：`*` 匹配任意长度，`?` 匹配一个字符，`[1-5]` 匹配其中一个字符，`[^8]` 匹配除 8 以外的一个字符。`{1..10}` 是花括号展开，例如 `touch {1..10}.c`。

位置参数：`$0` 是脚本名，`$1` 起是参数，`$#` 是参数个数。`$@` 在双引号里能保住每个参数的边界，比 `$*` 更适合传给别的命令。

---
## 一、变量的四则运算：


1. （（ &emsp; ））

不能进行浮点型的运算

调用的时候需要加 `$`

可以进行幂运算

可以进行自加自减

```c
 #!/bin/bash
  2 
  3 a=$(( 3**3)) //3的3次方
  4 echo $a

```

2. 【&emsp;】

不能进行浮点型的运算

调用的时候需要加 `$`

可以进行幂运算

```c
  1 #!/bin/bash
  2 
  3 a=$[ 3+3]
  4 echo $a

```

3. expr

需要命令置换符置换出来结果\` &emsp; `

算数之间需要空开

当进行乘法的时候需要用\区分

没有幂数运算

```c
1 #!/bin/bash
  2 
  3 a=`expr 1 \* 2`
  4 echo $a

```

练习：运算出a=3的3次方的值，b=5*7的值，交换

```c
1 #!/bin/bash
  2 
  3 a=$((3**3))
  4 b=`expr 5 \* $((4+2))`
  5 c=$a
  6 a=$b
  7 b=$c
  8 echo a=${a}b=$b

```
<br>
<br>

---
## 二、shell 语句

### 1. 解释性语句

+ #注释一行
+ :<<!注释多行
注释的shell语句
！
+ ：<<EOF
注释的shell语句
EOF

### 2.功能性语句

#### （1）test

结构：字符串 整型 文件

* 字符串的比较：

>test 字符串1 = 字符串2    ----比较两个字符串是否相等
test 字符串1 ！= 字符串2    ----比较两个字符串是否不相等
test -z 字符串---判断字符串为不为空
test -n 字符串---判断字符串是否不为空

```c
1 #!/bin/bash
  2 
  3 a="hello"
  4 b="hello"
  5 test $a != $b
  6 test -z $a
  7 test -n $a
  8 echo $?


```

* 整型的比较

>-eq---等于
-ne---不等于
-gt---大于
-lt--小于
-ge---大于等于
-le---小于等于

* 文件的比较

>-e ---判断文件是否存在
-f---判断文件是否是普通文件
-L---判断文件是否是链接文件
-S---判断文件是否是套接字文件
-b---判断文件是否是块文件
-c---判断文件是否是字符文件
-d---判断文件是否是目录文件
-p---判断文件是否为管道文件

* 文件的权限：

>-r--判断文件是否有可读权限
-w---判断文件是否有可写权限
-x---判断文件是否有可执行权限
文件1  -nt  文件2--判断文件1是否比文件2新（时间戳）
文件1  -ot  文件2--判断文件1是否比文件2旧（时间戳）

* 逻辑
>-o---或
>-a---与

```c
1 #!/bin/bash
  2 
  3 test -d $1 -a -f $2
  4 echo $?
~           

```

<br>

#### （2）read

把终端上的输入传给参数

read 变量1 变量2 

read -p "提示" 变量名

```c
1 #!/bin/bash
  2 
  3 read -p "please input tow numbern:" a b
  4 echo $a
  5 echo $b

```

read -t  时间 变量名---限制时间输入

超过时间会自动结束（以秒为单位）

```c
1 #!/bin/bash
  2 
  3 read -t 5 a b
  4 echo $a
  5 echo $b

```

read -n --限制输入的个数,超过个数也会自动结束

```c
 1 #!/bin/bash
  2 
  3 read -n 1 a b
  4 echo $a
  5 echo $b
~           
```

read -s ---隐藏输入

<br>

### 3. shell的控制语句

#### （1）if

第一种：
```c
if[]

then

​    shell语句；

fi
```
**<font color=red>注意：if和【】之间要隔一个空，表达式和【】也要隔一个空</font>**

```c
1 #!/bin/bash
  2 
  3 a=56
  4 b=34
  5 if [ $a -gt $b ]
  6 then
  7     echo "hello world"
  8 fi

```

第二种：
```c
if test语句

then

​    shell语句；

fi
```
```c
  1 #!/bin/bash
  2 
  3 a=56
  4 b=34
  5 if test $a -gt $b
  6 then
  7     echo "hello world"
  8 fi

```

if - elif-else

```c
1 #!/bin/bash
  2 
  3 read a b
  4 if test $a -gt $b
  5 then
  6     echo "hello world"
  7 elif test $a -eq $b
  8 then
  9     echo "zhangcheng"
 10 else
 11     echo "day3"
 12 fi

```

练习：输入一个文件名。判断这个文件是否存在，如果不存在，就创建，判断是否有可写权限，如果有，就把helloworld 写进去，如果没有，赋予可写权限，再写进去，如果存在就写入helloworld

```c
  1 #!/bin/bash
  2 
  3 read -p "please input a filename:" file
  4 if test -e $file
  5 then
  6     if test -w $file
  7     then
  8        echo "hello world">>$file //注意别忘了echo
  9    else
 10        chmod +w $file
 11        echo "hello world">>$file
 12     fi
 13 else
 14     touch $file
 15     echo "hello world">>$file
 16 fi

```
```c
case 表达式 in

​           表达式）

​              shell语句

​               ；；

表达式）

​      shell语句

​      ；；

esac
```
```c
  3 read a
  4 case  $a in
  5     1|2|3)
  6         echo "星期一"
  7         ;;
  8     2)
  9         echo "星期二"
 10         ;;
 11     3)
 12         echo "星期三"
 13         ;;
 14     4)
 15         echo "星期四"
 16         ;;
 17     5)
 18         echo "星期五"
 19         ;;
 20     6)
 21         echo "星期六"
 22         ;;
 23     7)
 24         echo "星期天"
 25         ;;
        *)
 27         echo "asdads"

 26 esac
```

用【】

```c
read a
  4 case  $a in
  5     [a-zA-Z])
  6         echo "星期一"
  7         ;;
  8     [zbc])
  9         echo "星期二"
 10         ;;


```

练习：模拟一个应用下载

```c
  1 #!/bin/bash
  2 
  3 read -p "请选择要下载的应用:" app
  4 read -p "请确认是否下载y|n|q)" chioce
  5 case $chioce in
  6     Y|y|yes)
  7         echo "$app正在下载中....."
  8         ;;
  9     N|n|no)
 10         echo "取消下载$app"
 11         ;;
 12     *)
 13         echo "退出"
 14 esac
 15 

```

#### （2）循环语句
```c
while 表达式

do

shell语句

done
```
```c
1 #!/bin/bash
  2 
  3 a=5
  4 while test $a -gt 0
  5 do
  6     ((a--))
  7     echo $a
  8 done
```

死循环
```c
while true
do
shell语句
done
```
for循环
```c
for（（表达式1；表达式2；表达式3））
do
shell语句
done
```
```c
1 #!/bin/bash
  2 
  3 
  4 i=5
  5 for((i=0;i<5;i++))
  6 do
  7     echo $i
  8 done

```
第二种
```c
for 变量 in 单词表
do
shell语句
done
```
```c
1 #!/bin/bash
  2 
  3 
  4 i=5
  5 for i in he li oi asda adsa ada ad
  6 do
  7     echo $i
  8 done

```

连续的

for 变量 in {起始..结束}

```c
 1 #!/bin/bash
  2 
  3 
  4 i=5
  5 for i in {a..z}
  6 do
  7     echo $i
  8 done

```

for 变量 in ``

```c
 1 #!/bin/bash
  2 
  3 
  4 i=5
  5 for i in `ls`
  6 do
  7     echo $i
  8 done

```

练习：求1到100的和

```c
 1 #!/bin/bash
  2 
  3 sum=0
  4 i=5
  5 for((i=0;i<101;i++))
  6 do
  7     sum=$(($sum+$i))
  8 done
  9 echo "sum=$sum"
 1 #!/bin/bash
  2 
  3 sum=0
  4 i=5
  5 for((i=0;i<101;i++))
  6 do
  7     sum=`expr $sum + $i`
  8 done
  9 echo "sum=$sum"

```



## 三、shell数组

shell脚本里面只有一维数组

没有数据类型

### 1. 数组的初始化

数组名=（元素1 元素2 元素3.。。。）

### 2. 数组的赋值：

数组名【下标】=内容

### 3. 数组的调用：

\${数组名【下标】}

### 4. 数组的遍历：

循环遍历

${arr[*]}

${arr[@]}

### 5. 求数组的长度：
```c
${#arr[*]}
```
```c
 1 #!/bin/bash
  2 
  3 arr=(hello world nihao shijie)
  4 arr[0]="zhangcheng"
  5 echo ${arr[0]}
  6 echo ${arr[@]}
  7 echo ${#arr[*]}
                      
```

练习：

数组的逆序打印（用交换）

shijie nihao world hello

```c
1 #!/bin/bash
  2 
  3 arr=(hello world nihao shijie)
  4 arr[0]="zhangcheng"
  5 echo ${arr[0]}
  6 echo ${arr[@]}
  7 len=${#arr[*]}
  8 for((i=0;i<$len/2;i++))
  9 do
 10     temp=${arr[$i]}
 11     arr[$i]=${arr[$(($len-$i-1))]}
 12     arr[$(($len-$i-1))]=$temp
 13 done
 14 
 15 echo ${arr[@]}

```

### 4. shell函数

没有数据类型

没有写形参，但可以传参

只有调用函数之后，函数里面的变量才会生效

函数里面定义的都是全局变量，如果要定义局部变量，加local

（1）函数的一般形式：
```c
function 函数名（）

{
    函数体
} 

或者：

函数名（）
{
    函数体
}
```
（2）函数的调用，直接函数名

（3）返回值return，可以通过$?来打印函数的返回值,如果有返回值，返回在0~256

```c
 1 #!/bin/bash
  2 
  3 add()
  4 {
  5     a=12
  6     return $a
  7 }
  8 add
  9 echo $?

```

（4）函数的传参

函数名 实参1 实参2.。。。

```c
函数体中用$1,$2$3.....来接受传递的实参
1 #!/bin/bash
  2 
  3 add()
  4 {
  5     a=12
  6     echo $1
  7     echo $2
  8     echo $3
  9     return $a
 10 }
 11 add 34 56 78
 12 echo $?
```

练习：写一个求和函数

```c
 1 #!/bin/bash
  2 read m n
  3 add()
  4 {
  5     sum=0
  6     for((i=$1;i<=$2;i++))
  7     do
  8         sum=$(($sum+$i))
  9     done
 10 }
 11 add m n
 12 echo $sum

```

<br>
<br>

---
