# NoVerify для VS Code

Показывает замечания линтера [NoVerify](https://github.com/qMBQx8GH/noverify) для PHP на панели **Problems**
и подчёркивает их в редакторе. Расширение локальное, в Marketplace его публиковать не нужно.

При сохранении PHP-файла оно:

1. ищет конфиг модуля `dev/phpat/noverify.yaml` в папке файла и выше, так что конфиг находится из любого файла модуля;
2. в фоне запускает `noverify check -c <конфиг> --output-json`;
3. заменяет замечания модуля новыми: исправленное пропадает, новое появляется, замечания других модулей не трогаются.

Замечания всего модуля показываются сразу, а не только по сохранённому файлу, как у `phpstan`.
Неиспользуемые переменные приглушаются, устаревшее зачёркивается.

## Установка

Нужны VS Code 1.74+, Node.js 18+ (только чтобы собрать пакет) и собранный `noverify`
(`make install` в репозитории `noverify`, он кладёт бинарник в `~/go/bin/noverify`).

```bash
cd /opt/noverify-vscode
npm run package                                   # соберёт noverify-0.1.0.vsix
code --install-extension noverify-0.1.0.vsix
```

То же самое в интерфейсе: *Extensions → ⋯ → Install from VSIX…*.
После установки перезагрузите окно (*Developer: Reload Window*).

Обновление: изменить код, поднять `version` в `package.json`, снова `npm run package`
и `code --install-extension noverify-<версия>.vsix --force`.

Удаление: `code --uninstall-extension local.noverify`.

## Конфиг модуля

Конфиг тот же, что для командной строки (`noverify check -c`), пути в нём считаются от файла конфига:

```yaml
# modules/clouds/dev/phpat/noverify.yaml
paths:
  - ../..
include:
  - ../../../main
  - ../../../vendor
exclude-files:
  - ../../../main/cli/bootstrap.php
exclude-checks:
  - useExitOrDie
```

Для файлов модуля без конфига расширение ничего не запускает.

## Команды

Палитра команд (`Ctrl+Shift+P`), раздел **NoVerify**:

| Команда | Что делает |
|---|---|
| **Check the module** | Проверяет модуль активного файла. Без открытого файла ищет конфиги в рабочей папке и предлагает выбрать. Её же запускает клик по значку **NoVerify** в строке состояния. |
| **Clear the reports** | Убирает все замечания NoVerify. |
| **Show the output** | Открывает журнал: команды, время, строки `Failed parsing` и ошибки. |

## Настройки

| Настройка | По умолчанию | Описание |
|---|---|---|
| `noverify.executable` | `noverify` | Путь к бинарнику или имя. Имя ищется в `PATH`, затем в `$GOBIN`, `$GOPATH/bin` и `~/go/bin` (VS Code, запущенный из меню, часто не видит `~/go/bin`). |
| `noverify.configFiles` | `["dev/phpat/noverify.yaml", "noverify.yaml"]` | Пути конфига относительно папки; ищутся в папке файла и выше. |
| `noverify.runOnSave` | `true` | Проверять модуль при сохранении PHP-файла. |
| `noverify.runOnOpen` | `false` | Проверить модуль при открытии его первого PHP-файла. |
| `noverify.minimumLevel` | `notice` | Самый низкий показываемый уровень: `notice` (всё, включая «возможно»), `warning`, `error`. |
| `noverify.extraArgs` | `[]` | Дополнительные аргументы `noverify check`. |
| `noverify.timeout` | `600` | Предел времени одной проверки, секунды. |

Серия сохранений подряд превращается в одну проверку, а сохранение во время проверки
запускает ещё одну: файл мог измениться после старта.
Сохранение самого `noverify.yaml` тоже перезапускает проверку.

## Разработка

```bash
npm test         # юнит-тесты и сквозной тест с поддельными vscode и noverify
```

`F5` в VS Code запускает отдельное окно с расширением (`.vscode/launch.json`).
Код без зависимостей и без сборки: `src/lib.js` не зависит от API VS Code,
`src/extension.js` получает модуль `vscode` как аргумент, поэтому его можно проверять без редактора.
