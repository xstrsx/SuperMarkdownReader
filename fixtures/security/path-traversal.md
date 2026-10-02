# 路径穿越与越权引用

授权根目录内的正常相对引用应可用：

![同级附件](./images/sibling.png)
![上级目录附件](../shared/up.png)
![子目录附件](sub/dir/deep.png)

以下引用必须被拒绝（越过授权根或使用绝对路径）：

![越界一次](../../outside.png)
![越界多次](../../../../etc/passwd)
![绝对路径](/etc/passwd)
![绝对路径两段](/data/data/dev.litedoc.viewer/files/secret)
![协议相对](//example.invalid/x.png)
![file 协议](file:///etc/passwd)
![content 协议](content://com.android.providers.media.documents/document/image%3A1)
![](%2e%2e%2f%2e%2e%2foutside.png)
![](images/../../outside.png)
![](./images/./../..%2foutside.png)

含特殊字符的合法名称：

![百分号编码](images/a%20b%23c.png)
![中文名称](images/中文 图片.png)
![井号与问号](images/name#frag.png)

附件目录未授权时，以上图片应显示占位与明确提示，而不是静默消失。
