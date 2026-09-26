---
title: "[工具] Markdown 基础"
published: 2020-04-26
tags: [Markdown, 笔记]
category: 工具
draft: false
---

# Markdown 概述

Markdown 是一种轻量级标记语言，于 2004 年提出。  
后缀为 `.md` 或 `.markdown`，可导出 HTML、Word、PDF。



---

<br>

# Markdown 标题

## 1.使用=和-标记一级和二级标题

> 这是一级标题
> \==========
> 这是二级标题
> \------------------

## 2.使用#号标记标题

> \# 一级标题
> \## 二级标题
> \### 三级标题
> ...
> \###### 六级标题

**注：\#后要加空格**

---

<br>
<br>

# Markdown 段落与字体格式

## 段落

1.在段落末尾使用两个以上空格加回车为换行

2.在段落与段落之间留出一个空行为换段落

## 字体格式

### 字体

> \*斜体文本\* > \_斜体文本\_ > \*\*粗体文本** >\_\_粗体文本\_\_ > \*\*\*粗斜体文本\*** >\_\_\_粗斜体文本\_\_\_

### 分割线

&nbsp; 在一行内用三个以上的星号，减号，下划线，在建立一个分割线  
&nbsp; 注意：行内不能有其他东西

> \*\*\* 
>  \---
> \_ \_ \_ 
> \------------

### ~~删除线~~

&nbsp; 如果要在文字上添加删除线，则在文字两端加上两个波浪线~~

> \~\~要删除线的文字~~

### 下划线

&nbsp; <u>下划线</u>可以通过 HTML 的`<u>`标签来实现

> \<u>带下划线的文本<\/u>

### 脚注

&nbsp; 在需要脚注[^像这样]的文字后写\[^脚注名]，并在后面的某个地方用\[\^要注明的文本]: 内容 来使用脚注。<u>且无论写什么脚注名，最后都会变成数字排列方式</u>

> [^脚注名]
>
> \[^脚注名]: 脚注内容

[^像这样]: 无论写什么脚注名，最后都会变成数字排列方式

### 标记 

&nbsp;&nbsp;&nbsp;&nbsp;将选中的文字用灰色背景加重（`像这样`）,就在文字的两旁加`

> \`文字`

### 特殊符号失效

&nbsp; 如果想让特殊符号失效，即打出原有符号样子(如#),则在特殊符号前加反切线\

> \\ 
>  \\<\u>...<\/u>

---

<br>
<br>

# Markdown 列表

&nbsp; Markdown 支持有序列表和无序列表（在标记后面要有空格）

### 无序列表

无序列表使用星号(\*)、加号(+)或是减号(-)作为列表标记

> \* 第一项 
> \* 第二项 
> \* 第三项
>
> \+ 第一项
> \+ 第二项
> \+ 第三项
>
> \- 第一项
> \- 第二项
> \- 第三项

- 第一项
- 第二项
- 第三项

<br>

### 有序列表

有序列表使用数字加上`.`号来表示，如：

>  1. 第一项
>  2. 第二项
>  3. 第三项

1. 第一项
2. 第二项
3. 第三项

---

<br>
<br>

# Markdown 区块

Markdown 区块引用时在段落开头使用>号，后面要跟个空格符号

> \>区块内文字,效果就是这像一行一样出现阴影
>
> > 打多个>还可以还可以内嵌(如这行的>>)

1. 区块中使用列表的话，就在>后面用列表语法就行
   > \> 1. 第一项
   > \> 2. 第二项
   > \> 3. 第三项
   >
   > \> + 第一项
   > \> + 第二项
   > \> + 第三项

<br>

2. 列表中使用区块，则要在>前添加四个空格的缩进

> \* 第一项
> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;\>区块内容
> \* 第二项

效果如下：

- 第一项
  > 区块内容
- 第二项

---

<br>
<br>

# Markdown 代码

- 如果是段落上的一个函数或片段的代码可以用反引号(`)将内容包起来

> \`printf()`函数

`printf()`函数  
<br>

- 如果是代码区块，则使用 4 个空格或者一个制表符(Tab 键)

> &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 代码内容

    public static void main(String[] args){
        System.out.println("hello,world")
    }

<br>

- 也可以用 \``` .... \``` 来包裹一段代码，还可以在```后面指定一种语言

> \```java
> public static void main(String[] args){
> System.out.println("hello,world")
> }
> \```

```java
public static void main(String[] args){
        System.out.println("hello,world")
    }
```

---

<br>
<br>

# Markdown 链接

- 普通方式

> \[链接名称](链接地址)
> 或者<链接地址>

[技术文档书写规范](https://www.jianshu.com/p/3b638180e42c)

<https://www.jianshu.com/p/3b638180e42c>
<br>

- 高级链接
  如果链接太长时，可在[连接名称]后面设置一个[标签名],则可在后面的任意位置写[标签名]: 链接  
  **注意：`[标签名]:` 冒号前面以及两个中括号之间[][]不要留空格**

> \[技术文档书写规范]\[1]
> \[csdn 官网]\[csdn]
>
> \[1]: https://www.jianshu.com/p/3b638180e42c >\[csdn]: https://www.csdn.net/

[技术文档书写规范][1]
[csdn 官网][csdn]

[1]: https://www.jianshu.com/p/3b638180e42c
[csdn]: https://www.csdn.net/

---

<br>
<br>

# Markdown 图片

## 基本语法

> \!\[alt 属性文本](图片地址)
>
> \!\[alt 属性文本](图片地址 "title 属性文本")

alt 为图片加载出错时的代替文本  
title 为鼠标放在图片上时所显示的文字

## 图片地址的传入方法

1. 通过图床将图上传到网上后使用图片的链接
   > \!\[图片加载出错](https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1587895752391&di=e2f0ba8e2108ab4f04b19700233f121f&imgtype=0&src=http%3A%2F%2Fgss0.baidu.com%2F-4o3dSag_xI4khGko9WTAnF6hhy%2Fzhidao%2Fpic%2Fitem%2F810a19d8bc3eb13537a41c57aa1ea8d3fc1f44fe.jpg "这是 title 属性")

![图片加载出错](https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1587895752391&di=e2f0ba8e2108ab4f04b19700233f121f&imgtype=0&src=http%3A%2F%2Fgss0.baidu.com%2F-4o3dSag_xI4khGko9WTAnF6hhy%2Fzhidao%2Fpic%2Fitem%2F810a19d8bc3eb13537a41c57aa1ea8d3fc1f44fe.jpg "这是title属性")
<br>

2. 将图片存入本地，通过 [绝对路径/相对路径](https://blog.csdn.net/chudelong1/article/details/90697409) 来加载图片(相对路径是以当前的 md 文件所在目录为起点)

> \!\[图片出不来了](./mdphoto/markdownlearn/0.jpg)

![图片出不来了](./0.jpg)

当然，当地址过长时也可以像链接那样将(...)变成变量名

> \!\[图片加载出错][photo 1]
>
> \[photo 1]: https://timgsa.baidu.com/timg?image&quality=80&size=b9999_10000&sec=1587895752391&di=e2f0ba8e2108ab4f04b19700233f121f&imgtype=0&src=http%3A%2F%2Fgss0.baidu.com%2F-4o3dSag_xI4khGko9WTAnF6hhy%2Fzhidao%2Fpic%2Fitem%2F810a19d8bc3eb13537a41c57aa1ea8d3fc1f44fe.jpg

**<u>注意：如果是想将本地连接的图片通过 hexo 传到远端时，直接使用是无效的,要实现下列步骤</u>**

1. 配置 hexo 根下的`_config.yml`里面的`post_asset_folder:false`这个选项设置为`true`。
2. git bash 安装插件：`npm install https://github.com/7ym0n/hexo-asset-image --save` , 安装之后再生成新 md 文件时同目录下会出现同名的文件夹，图片可放进那里
3. 这时再使用上面的语法便能成功

---

<br>
<br>

# Markdown 表格

&nbsp; Markdown 中制作表格用`|`来分割不同的单元格，用`-`在分割表头和其它行

> \|表头 1|表头 2|表头 3|
> \| :&nbsp;---&nbsp;&nbsp; &nbsp;|:&nbsp;&nbsp; ---&nbsp;&nbsp;: |&nbsp;&nbsp;&nbsp;---&nbsp;&nbsp;: |
> |左对齐|中对齐|右对齐|
> |左对齐效果|中对齐效果|右对齐效果|

| 表头 1     |   表头 2   |     表头 3 |
| :--------- | :--------: | ---------: |
| 左对齐     |   中对齐   |     右对齐 |
| 左对齐效果 | 中对齐效果 | 右对齐效果 |

<br>
<br>

还能设置表格的对齐方式(默认向左对齐)：

- **`-:`** 设置内容和标题栏右对齐
- **`:-:`** 设置内容和标题栏中对齐
- **`:-`** 设置内容和标题栏左对齐

**注：最右边的`|`可以省略**
