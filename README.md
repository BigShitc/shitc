# shitc

把伪代码文件交给模型，取回真实代码，编译它，需要时再运行它。

```console
$ cat hello.shit
prit("helloword")

$ shitc hello.shit
$ ls
hello.shit          # 源码在 ~/.shitc/build/<id>/，可执行文件在当前目录

$ shitc run hello.shit
helloword
```

## 它是什么

ShitLang 没有固定语法。一个 `.shit` 文件可以是一句拼错的函数调用、一段中文描述、或者一坨全角符号的伪 C。shitc 把文件内容发给模型，模型决定用哪种真实语言、生成哪些文件、用什么命令构建和运行；shitc 负责写入文件、执行构建、在 `run` 时执行程序。

- 目标语言由模型选择，优先使用本机 PATH 上已有的工具链
- 自动识别当前 shell（bash / zsh / fish / cmd / pwsh 等），生成的命令按该 shell 的语法执行
- 使用 OpenAI 兼容协议（`POST {baseUrl}/chat/completions`），支持流式输出、结构化 JSON、重试与降级
- 默认只编译不运行；`shitc run` 才会执行程序
- 源码写入构建缓存，编译型语言的可执行文件放到当前目录
- `-s` 只生成源码文件，适合本机没有目标编译器的情况
- `shitc models` 从 `/models` 拉取可用模型，输入 `#6` 选择第 6 个
- 支持 reasoning / CoT 参数配置
- 配置位于 `~/.shitc`

## 安装

需要 Node.js 20.11 或更高版本。

```bash
npm install -g .          # 从当前目录全局安装
pnpm add -g .             # pnpm 全局安装（需要 pnpm 的 bin 目录在 PATH）
pnpm link --global        # 开发时链接当前目录
```

从源码开发：

```bash
pnpm install
pnpm build
pnpm test
```

## 快速开始

```bash
# 配置模型端点，写入 ~/.shitc/config.json
shitc init
shitc init --base-url https://api.deepseek.com/v1 --api-key sk-xxx --model deepseek-chat

# 查看端点提供哪些模型，#6 选择第 6 个
shitc models
shitc models '#6'

# 编译 / 运行
shitc hello.shit
shitc run hello.shit

# 指定输出
shitc -o ./main --lang c examples/main.c   # 编译型：可执行文件写到 ./main
shitc -o ./main.py hello.shit              # 解释型：入口源码写到 ./main.py
shitc -d build hello.shit                  # 目录：源码和产物都放进 ./build

# 只生成源码，不构建不运行
shitc -s -o ./main.cbl --lang cobol examples/shitlang/fizzbuzz.shit
shitc --emit-only hello.shit

# 查看编译过程与机器可读结果
shitc --log run hello.shit
shitc --json run hello.shit
```

## 工作方式

```
源文件
  → 读取配置、识别 shell 和本机工具链
  → 构造 OpenAI 协议请求，交给模型
  → 解析返回的 JSON：目标语言、文件、构建命令、运行命令
  → 写入构建目录
  → 构建（编译型语言）
  → 仅 run 时运行
```

源文件被当作代码处理。像「请帮我写一个排序算法」这类发给模型的请求会被判为无效源码，按语法错误报告（退出码 65）；描述程序行为的伪代码（例如「算 1 到 100 的和并打印」）则会正常编译。

## 配置

`~/.shitc/config.json`，权限 0600。目录可用 `SHITC_CONFIG_DIR` 覆盖。

```json
{
  "baseUrl": "https://api.deepseek.com/v1",
  "apiKey": "sk-...",
  "model": "deepseek-chat",
  "temperature": 0,
  "maxTokens": 4096,
  "timeoutMs": 120000,
  "reasoningParam": "reasoning_effort",
  "reasoningValue": "high"
}
```

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `baseUrl` | OpenAI 兼容端点，通常以 `/v1` 结尾 | `https://api.openai.com/v1` |
| `apiKey` | Bearer Token，本地端点可留空 | `""` |
| `model` | 模型名 | `gpt-4o-mini` |
| `temperature` | 采样温度 0–2 | `0` |
| `maxTokens` | 最大输出 token | `4096` |
| `timeoutMs` | 请求超时（毫秒） | `120000` |
| `reasoningParam` | CoT/推理请求字段，例如 `reasoning_effort`；留空表示不启用 | `""` |
| `reasoningValue` | 该字段的值，例如 `low`、`medium`、`high`、`max`、`true` | `""` |

`shitc init` 会依次询问端点、密钥、模型（可以从 `/models` 里按编号选择）、温度、maxTokens，以及 reasoning 参数；reasoning 参数留空即不启用，填写后会继续询问级别。

也可以用 `shitc config set` 修改：

```bash
shitc config set model deepseek-chat
shitc config set reasoningParam reasoning_effort
shitc config set reasoningValue high
```

环境变量会覆盖配置文件：

| 变量 | 说明 |
| --- | --- |
| `SHITC_BASE_URL` / `OPENAI_BASE_URL` | 端点 |
| `SHITC_API_KEY` / `OPENAI_API_KEY` | 密钥 |
| `SHITC_MODEL` / `OPENAI_MODEL` | 模型 |
| `SHITC_TEMPERATURE`、`SHITC_MAX_TOKENS`、`SHITC_TIMEOUT_MS` | 对应字段 |
| `SHITC_REASONING` | `param=value` 形式，例如 `reasoning_effort=high` |
| `SHITC_REASONING_PARAM`、`SHITC_REASONING_VALUE` | 分开设置 CoT 字段与值 |
| `SHITC_CONFIG_DIR` | 配置目录 |
| `SHITC_OUT_DIR` | 输出根目录 |
| `SHITC_SHELL` | 指定 shell |
| `SHITC_NO_STREAM=1` | 关闭流式响应 |

## 命令

```
shitc <file.shit>                 编译
shitc run <file.shit>             编译并运行
shitc -                           从 stdin 读取源文件内容
shitc models [#n|name]            列出并选择模型
shitc init                        配置端点
shitc config [list|get|set|path]  查看或修改配置
shitc doctor                      检查配置、shell、工具链与连通性
```

| 选项 | 说明 |
| --- | --- |
| `-l, --lang <language>` | 指定目标语言 |
| `-o, --out <path>` | 输出文件：编译型为可执行文件，解释型为入口源码，`-s` 时为源码文件 |
| `-d, --out-dir <dir>` | 输出目录：源码与产物放在一起 |
| `-s, --source` | 只写源码文件，不构建不运行 |
| `--emit-only` | 生成并打印源码，不构建不运行 |
| `--log` / `-log` | 显示编译过程、生成计划与构建/运行命令 |
| `--shell <shell>` | 指定执行命令使用的 shell |
| `--model`、`--base-url`、`--api-key` | 临时覆盖配置 |
| `--timeout`、`--temperature`、`--max-tokens` | 临时覆盖参数 |
| `--json` | 机器可读结果 |
| `-q, --quiet` | 不显示进度 |
| `-v, --verbose` | 显示模型请求细节 |
| `-h, --help` / `-V, --version` | 帮助 / 版本 |

## 输出

```
~/.shitc/build/
└── 20251020-004750-9f3a/
    └── main.c          # 生成的源码
```

- 源码默认写入 `~/.shitc/build/<id>/`，不会出现在工作目录
- 编译型语言的可执行文件在构建完成后移到当前目录
- `-o <path>` 指定输出文件；`-d <dir>` 指定输出目录；结尾带 `/` 的路径也按目录处理
- `-s` 只输出源码，不调用编译器；`--emit-only` 同时把源码打印到终端
- 每个构建目录独立，保留最近 20 份
- 构建目录可以用 `--log` 查看

## 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `64` | 用法错误 |
| `65` | 语法错误、构建失败或运行失败 |
| `66` | 输入文件不可用 |
| `70` | 编译器内部错误（ICE） |
| `130` | 被中断 |

ICE 代码表示编译器自身或模型交互出现问题：`ICE-001` 配置、`ICE-002` 请求、`ICE-003` 模型响应、`ICE-004` 结构化输出不合法、`ICE-005` 没有生成程序、`ICE-006` 路径不安全、`ICE-007` 写入失败、`ICE-008` 缺少命令、`ICE-009` 进程启动失败、`ICE-010` 内部不变量、`ICE-011` 未预期错误、`ICE-012` 危险命令。

## 示例

| 文件 | 内容 |
| --- | --- |
| `examples/hello.shit` | `prit("helloword")` |
| `examples/fizzbuzz.shit` | 中文伪代码版 FizzBuzz |
| `examples/sum-1-to-100.shit` | 中文描述求和 |
| `examples/main.c` | 全角符号与拼写错误的伪 C |
| `examples/linked-list.c` | 链表伪 C |
| `examples/shitlang/` | 虚构语言「屎语零号」，含 `SPEC.md`、`count.shit`、`fizzbuzz.shit` |

```bash
shitc run examples/shitlang/count.shit
shitc run examples/linked-list.c
shitc -s -o ./main.cbl --lang cobol examples/shitlang/fizzbuzz.shit
```

## 说明

- 目标语言需要本机存在对应工具链；缺失时构建阶段会失败（退出码 127），可以用 `-s` 只生成源码，或用 `shitc doctor` 查看已安装的工具链
- Windows 的 shell 检测是启发式的，可以用 `--shell` 指定
- 代理：Node 内置 fetch 不读取 `HTTP_PROXY`；Node 24 可以设置 `NODE_USE_ENV_PROXY=1`，其他情况把 `baseUrl` 指向网关
- 生成的程序在构建目录中执行；需要它操作当前目录时用 `-d .`
- 生成的代码会在本机执行，建议先用 `--emit-only` 或 `-s` 检查

## License

MIT
