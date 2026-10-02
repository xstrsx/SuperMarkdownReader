# 数学与化学方程验证

## 四种分隔符

行内美元：$a^2 + b^2 = c^2$

行内括号：\( \frac{\partial f}{\partial x} \)

块级美元：

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

块级方括号：

\[
\sum_{k=1}^{n} k = \frac{n(n+1)}{2}
\]

## 分式、根式、上下标

$$ \frac{a}{b} \quad \sqrt[3]{x} \quad x^{2}_{i} \quad \binom{n}{k} \quad \overline{AB} \quad \vec{v} $$

## 积分与求和

$$ \oint_C \vec{F}\cdot d\vec{r} \qquad \iint_D f\,dA \qquad \sum_{i=1}^{n}\sum_{j=1}^{m} a_{ij} \qquad \prod_{k=1}^{n} k $$

## 矩阵与 cases

$$
\begin{pmatrix}
a & b \\
c & d
\end{pmatrix}
\begin{vmatrix}
1 & 2 \\
3 & 4
\end{vmatrix}
$$

$$
f(x) = \begin{cases}
x^2 & x \ge 0 \\
-x & x < 0
\end{cases}
$$

## 多行结构

$$
\begin{aligned}
a + b &= c \\
x + y &= z
\end{aligned}
$$

$$
\begin{align}
p &= q + r \\
s &= t - u
\end{align}
$$

$$
\begin{gather}
\alpha = \beta \\
\gamma = \delta
\end{gather}
$$

## 编号、标签与引用

$$
E = mc^2 \label{eq:energy}
$$

见式 \eqref{eq:energy} 与式 \ref{eq:mass}。

$$
m = \frac{m_0}{\sqrt{1 - v^2/c^2}} \tag{质量} \label{eq:mass}
$$

前向引用：\ref{eq:later}。

$$
\lim_{n\to\infty} \left(1 + \frac{1}{n}\right)^n = e \label{eq:later}
$$

## 自定义宏

$$
\newcommand{\R}{\mathbb{R}}
\newcommand{\norm}[1]{\left\lVert #1 \right\rVert}
\norm{x} \in \R^n
$$

$$
\gdef\myvec#1{\mathbf{#1}}
\myvec{v} \cdot \myvec{w}
$$

## 常见符号与稀有字形

$$ \forall \varepsilon > 0,\ \exists \delta > 0 \qquad \aleph_0 < \mathfrak{c} \qquad \mathcal{L}, \mathbb{N}, \mathbb{Z}, \mathbb{Q}, \mathbb{R}, \mathbb{C} $$

$$ \varphi, \vartheta, \varpi, \varrho, \varsigma, \epsilon, \hbar, \ell, \Re, \Im, \wp, \partial, \nabla, \infty $$

## 化学（mhchem）

$$ \ce{2H2 + O2 -> 2H2O} $$

$$ \ce{N2 + 3H2 <=>[Fe][\Delta] 2NH3} $$

$$ \ce{H2O <=> H+ + OH-} $$

$$ \ce{^{227}_{90}Th+} \qquad \ce{^14C} \qquad \ce{[UO2]^2+} \qquad \ce{SO4^2-} $$

$$ \ce{A ->[{\text{催化剂}}] B} $$

$$ \ce{CO2 + C -> 2CO} \qquad \ce{CaCO3 ->[\Delta] CaO + CO2 ^} $$

$$ \ce{Zn^2+ <=>[\ce{+ 2OH-}][\ce{+ 2H+}] Zn(OH)2 v} $$

$$ \pu{123 kJ//mol} \qquad \pu{1.5 mol//L} $$

## 边界

单个美元符号 $ 不应产生公式。

价格：$5 与 $10 必须原样显示。

公式超过上限或语法错误时应显示局部错误与源码，例如：`$ \frac{1}{ $`（未闭合，按文本保留）。

$$ \begin{aligned} a &= b \end{aligned} $$
