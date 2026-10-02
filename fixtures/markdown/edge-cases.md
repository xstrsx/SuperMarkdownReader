# 边界情形

价格与货币：$5、$10.99、US$ 100，以及带转义的 \$99 必须保持原样。

两个价格相邻：$5 和 $10 不应组成公式。

数学与货币混排：单价 $x$ 元，总价 $5$ 元，公式 $y = 2x$。

代码中的美元符号：

```text
$not math$ and \(not math\)
```

行内代码 `$also$` 与 `\(x\)` 都不参与数学解析。

链接目标含美元符号：[价格](https://example.invalid/price?a=$5&b=$6) 与自动链接 <https://example.invalid/a$b>。

---

列表与围栏的交叉：

1. 列表项一

   ```js
   const a = 1;
   ```

2. 列表项二

   | 列 | 值 |
   | --- | --- |
   | 1 | 2 |

---

跨段引用与尾部定义：

[ref-one]: https://example.invalid/one "标题一"
[ref-two]: https://example.invalid/two

使用引用式链接 [第一个][ref-one] 与 [第二个][ref-two]，定义在文件末尾。

[collapsed]: https://example.invalid/collapsed

折叠式引用 [collapsed][] 也支持。

脚注定义在末尾[^tail]。

[^tail]: 尾部脚注。

---

中文标题锚点

## 中文标题

## 中文标题

## 中文 标题

## English Heading

## Duplicate

## Duplicate

## `代码标题` 与 **粗体标题**

---

超长段落（用于换行与滚动验证）：

这是一段很长的文本用来测试换行与横向滚动行为，aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 结束。

| 超宽表格列 A | 超宽表格列 B | 超宽表格列 C |
| --- | --- | --- |
| 很长的单元格内容很长的单元格内容很长的单元格内容很长的单元格内容 | 第二列同样很长很长很长很长很长 | 第三列也一样也一样也一样 |

```text
一行非常长的代码 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```
