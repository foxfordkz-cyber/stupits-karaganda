# Human review gate — этап 4

Это передача языковых предложений на настоящую проверку, затем интегратору. Общие
схемы bundle/report/reviews и чужие модули не изменены. Диагностические правила 1.4.0
не расширены. Ни очередь, ни оценка A/B не создают человеческих одобрений.

## Запуск

Из корня checkout Бекзата, Node 22+ и Python 3.10+, после штатного `npm ci`:

```powershell
node modules/language/review-smoke.mjs --out C:/Temp/locqa-private/stage4-smoke-001 --core-root C:/path/to/core-checkout --report-root C:/path/to/report-checkout --linguistics-root C:/path/to/linguistics-checkout
node modules/language/human-review.mjs --prepare C:/Temp/locqa-private/human-packet-001
```

Все выходные пути должны быть новыми и вне **любого Git checkout**, включая worktree.
В трёх командных checkout нужны штатные зависимости. Smoke требует реальные компоненты
и не подменяет отсутствующий компонент. Обычный `smoke.mjs` без корней по-прежнему
явно использует существующие командные заглушки.

Для подготовленного bundle и отдельного language-report:

```powershell
node modules/language/check.mjs --bundle C:/Temp/locqa-private/bundle.json --glossary C:/Temp/locqa-private/glossary.csv --out C:/Temp/locqa-private/language-001.json --cache C:/Temp/locqa-private/language-cache
node modules/language/review-gate.mjs --bundle C:/Temp/locqa-private/bundle.json --report C:/Temp/locqa-private/language-001.json --details C:/Temp/locqa-private/language-001.json.details --reviews C:/Temp/locqa-private/human-reviews.json --source C:/Temp/locqa-private/source.arb --target C:/Temp/locqa-private/target.arb --state C:/Temp/locqa-private/review-ledger --out C:/Temp/locqa-private/gate-001.json --core-root C:/path/to/core-checkout --linguistics-root C:/path/to/linguistics-checkout --reviewers-file C:/Temp/locqa-private/reviewer-policy.json
```

Пилот language: `--limit 100`, полный проход — без limit, тот же cache. Gate проверяет
снимок выбранных строк, сохраняет `scan_scope`; пилот не означает проверку всего корпуса.
`--report` — именно языковой отчёт, не объединённый массив. Исходные ARB используются
для сверки с нормализованным bundle, не перезаписываются.

Политика имеет форму `{"reviewers":["имя настоящего уполномоченного проверяющего"]}`.
Её составляет команда. Пустая политика не разрешает ни одного решения. Это allowlist,
не аутентификация, не доказательство личности или владения казахским языком.
Пока проверок нет, официальный reviews содержит `decisions: []`. Программа не заполняет
`reviewer`, `reviewed_at` или `reviewed_by_human=true` за человека.

## Существующая очередь v2

Один sidecar `review_queue.json`. Поля общего finding остаются неизменными. Каждая строка
добавляет entry_id/key/occurrence, точные source/target hashes, context, original_text,
индексы provenance и стабильный review_id. При перестановке входных записей стабильные
идентификаторы сохраняются, позиционные индексы строятся заново.

`candidates[]` содержит полный текст, SHA-256 текста, candidate_id, метод генерации,
`technical_validation: pending_core` и `reviewed_by_human: false`. `proposed_text` задан
только для единственного полного кандидата. Поле `suggestion` может быть инструкцией
редактору и **никогда** не превращается автоматически в текст перевода.

Если полного кандидата нет, статус `needs_human_translation`. Несколько вариантов
внутри находки дают `conflicting_candidates`; несовпадающие варианты разных находок
для одной записи перечислены в `conflicting_candidate_ids`. Например, два отдельных
орфографических исправления не объединяются автоматически. Человек может предоставить
полный вариант через `edited`. Приоритет: high → medium → low, затем key/locale/occurrence.

Старые v1-снимки не перезаписывайте. Запустите language в новый файл с тем же cache,
получите v2 и сохраните прежнюю очередь как историю. Старый UI должен подключить v2
явно. Никаких общих schema migrations этот PR не выполняет.

## Решение и техническая граница

Используется официальный `contracts/reviews.schema.json`: key, entry_id, decision,
original_text/approved_text, source_hash/original_hash/approved_hash, reviewer,
reviewed_at, reviewed_by_human. `accepted` обязан совпасть с полным текущим кандидатом;
для собственной редакции человека нужен `edited`; rejected имеет approved_text/hash=null.
Один entry_id имеет одно решение в снимке, полная история остаётся отдельной.

Gate перестраивает очередь Python-кодом её владельца, проверяет идентичность report,
proposals и индексов; затем сверяет решение с текущим bundle. При смене source или
original target старое одобрение не передаётся. Оно остаётся в imported_reviews как
история с кодом отказа. Статус машинной очереди всегда остаётся pending/false.

Технические проверки делегированы:

- `core.normalizeArbs`: точное соответствие исходных ARB и bundle;
- `core.checkBundle`: кандидаты, placeholders/ICU и технические diagnostics;
- `linguistics.auditReviews`: официальный аудит решений Айданы;
- `core.exportApproved`: чистый пробный экспорт и существующий release gate. Полученный
  текст немедленно отбрасывается; в результате остаются хэш и аудит, `flutter_verified:false`.

Собственного ICU/ARB-анализатора здесь нет. Нельзя получать разрешение на экспорт при
отсутствии core или linguistics. Дубли ключей консервативно блокируются до разрешения
интегратором. Missing/empty target делегированы core и не входят в языковую очередь.
Решения вне языковой очереди не принимаются этим gate: передавайте ему соответствующий
снимок, сохраняя общий журнал у владельца. Неверный UTF-8, непарные surrogate, повторные
JSON-поля, nonfinite числа и слишком глубокий JSON отклоняются на границе ввода.

| Статус | Смысл |
|---|---|
| HUMAN_REVIEW_PENDING | Нет подтверждённых исправлений; `unconfirmed_entry_ids` ожидают человека |
| READY_FOR_INTEGRATOR | Передаваемые решения проверены; это не разрешение финального релиза |
| NO_APPROVED_CHANGES | Проверяющий отклонил все переданные варианты |
| BLOCKED | Устаревшие/неавторизованные решения, неполный scan или технический отказ |
| ALREADY_HANDED_OFF | Эти версии уже выданы; используйте существующую receipt |
| PARTIALLY_HANDED_OFF | Часть пачки уже выдана; отделите ещё не выданные решения |
| CONFLICTING_PREVIOUS_HANDOFF | Для уже выданной версии предложен другой approved hash |

Коды CLI: 0 для pending/ready/no changes/already; 2 для blocked/partial/conflict;
1 для ошибки валидации, блокировки состояния или записи. Потребитель обязан проверять
статус JSON, а не считать каждый код 0 одобрением. Неподтверждённые находки могут остаться
при READY_FOR_INTEGRATOR: готова только указанная пачка решений.

## История, повтор и восстановление

`--state` — постоянный отдельный приватный каталог для одного проекта/корпуса. Не
создавайте новый ledger для повтора. Ключ выданной версии: locale + entry_id + source_hash
+ original_hash. Receipt содержит проверенные существующие reviews, хэши входов и
пробный аудит core. Входные решения копируются; новые решения программа не создаёт.

Эксклюзивный `review-gate.lock` разрешает одного writer. Receipt публикуется первой,
через fsync временного файла и атомарный hard link без замены существующего файла.
Итоговый JSON записывается отдельно, также без перезаписи. Это требует локальной ФС с
hard links (проверены NTFS и Linux CI); неподдерживаемая ФС вызывает ошибку.

После прерывания между receipt и выходным JSON повтор с тем же state и новым out вернёт
ALREADY_HANDED_OFF и ссылку на прежнюю receipt. Она остаётся источником восстановления.
Повреждённая или конфликтующая история блокирует выдачу. Остатки `*.tmp` не считаются
receipt. При аварийном завершении процесса lock может остаться: сначала оператор
проверяет, что writer больше не работает, сохраняет копию state, затем удаляет только
этот lock. Автоматического захвата чужой блокировки или очистки истории нет.

Гарантируется защита от повторной **выдачи в одном сохранённом ledger**, не глобальное
exactly-once применение. Интегратор записывает receipt_id в свой журнал, повторно
сверяет текущие ARB через core exporter и выполняет Flutter/release проверки. Стирание
ledger теряет защиту. Power loss, сетевые ФС и злонамеренная правка всего журнала не
покрываются обещанием crash recovery; хэши не являются цифровыми подписями.

## Проверка носителем и метрики

Пакет из 12 вымышленных случаев охватывает корректный исходный вариант, спорный стиль,
ложноположительную гипотезу, ошибочное предложение, морфологию, терминологию и смысл.
Это авторские AI-гипотезы, **не** измерение детектора и не подтверждённые метки.
Случай с удалённым placeholder намеренно плохой и не должен пройти технический gate.

1. Координатор хранит `coordinator/packet.json`, seed и соответствие A/B приватно.
2. Проверяющему выдаётся только `reviewer/blind-sheet.json`: source, A, B и пустые поля.
3. После фиксации слепых ответов выдаётся `second-pass/precision-sheet.json` для оценки
   конкретных находок. Ранний доступ к нему или публичному исходнику примеров нарушит
   слепой протокол; автоматической изоляции прав доступа этот CLI не обещает.
4. Заполненные файлы и reviewer-policy подаются штатным общим scoreBlindReview и
   scorePrecisionReview через обёртку ниже. A/B предпочтение не является reviews-одобрением.

```powershell
node modules/language/human-review.mjs --packet C:/Temp/locqa-private/human-packet-001 --blind C:/Temp/locqa-private/filled-blind.json --precision C:/Temp/locqa-private/filled-precision.json --reviewers-file C:/Temp/locqa-private/reviewer-policy.json --out C:/Temp/locqa-private/human-score-001.json
```

Необязательный `--gate` принимает сохранённый успешно проверенный снимок решений для
отдельных acceptance/rejection counts; это исторический снимок, не новая сверка с
позднее изменёнными ARB. Для актуального допуска запускайте gate заново.

- Acceptance = (accepted + edited) / все проверенные официальные решения.
- Rejection = rejected / тот же знаменатель.
- False-positive review rate = отвергнутые находки / проверенные находки; это не FPR
  по всем корректным строкам и не оценка реального детектора на этом учебном пакете.
- Correction quality = победы предлагаемого варианта / оценённые A/B/tie;
  `cannot_assess` исключён из знаменателя.

При нулевых знаменателях значения null, статус HUMAN_REVIEW_PENDING. Частичная оценка
сохраняет reviewed/unreviewed, complete и знаменатели. Нет выдуманных человеческих
оценок. В автоматических тестах есть явно названные TEST_DOUBLE_NOT_HUMAN объекты,
изолированные от выдаваемого пакета и реальной статистики.

## Проверки и передача команде

```powershell
npm test
npm run check
python modules/language/benchmark/run.py --dataset development --baseline C:/path/to/pr3/modules/language --out C:/Temp/locqa-private/dev-001 --sizes 100,1000,5600
python modules/language/benchmark/run.py --dataset holdout --baseline C:/path/to/pr3/modules/language --out C:/Temp/locqa-private/holdout-001 --sizes ""
python modules/language/benchmark/sequential.py --out C:/Temp/locqa-private/cache-001
```

`npm test` включает Python regression, Node contract/failure/queue/Unicode/cache tests.
CI использует doubles для отсутствующих owner API; отдельный review-smoke проверяет
реальные компоненты. Его пять safety cases используют только временные in-memory
test-double решения, которые не сохраняются как человеческие reviews.

Регрессия против PR3: development 77/42 — TP42 FP0 FN0; post-freeze 63/28 — TP23 FP0
FN5, precision 1.0, recall 0.821429, F1 0.901961. Метки не менялись. Этот post-freeze набор
создан тем же AI и не является независимым человеческим holdout. Независимая проверка
носителем пока ожидается. Confidence не интерпретируется как измеренная точность.

Замер 31.10.2026, тот же движок, tracemalloc включён: 100/1000/5600 синтетических строк
cold 0.285/1.765/13.092 с, warm 0.097/1.102/5.118 с. Warm cache 100%, findings/index/proposals
побайтово совпали. Пиковые Python-аллокации 5600 warm — 12.15 MiB; это не полный RSS.
Три последовательных файла дали hits 0/100, 50/100, 100/100. Внешних модельных запросов
0, provider cost $0; стоимость разработки/CPU/подписки не включена. Это один desktop
замер, не SLA и не доказательство ускорения по сравнению с другим состоянием машины.
Эти цифры относятся к analyze, не к времени UI или финального экспорта.

Реальный review-smoke: core e216ac68bf581f18974473c72574f46ef29098c0,
linguistics d644e43f6063a411261791cf34b62487e229ba06,
report 957e8b0ffdaf722c471b7cb1c43b2c19d177fb0d. Маршрут занял 5.536 с на этой машине,
дал 1 языковую / 6 объединённых находок, 1 entry ожидает человека, receipt отсутствует.
5 технических safety cases прошли. Реальных человеческих решений 0, Flutter на
исправлениях этого gate ещё не выполнялся. Это совместимость указанных версий.

Айдане: проверить терминологию, смысл, морфологию, полный вариант и контекст, заполнить
официальные решения своим именем/временем, отдельно оценить учебный пакет. Тони:
подключить v2 sidecar, показывать полный кандидат отдельно от suggestion, pending/stale,
конфликты и приоритет; сохранить существующие reviews/history, не маппировать индексы
языкового отчёта непосредственно на merged report. Интегратору: подключить точные
версии core/linguistics, управлять reviewer-policy и одним ledger, разрешить дубли,
проверить receipt/current ARB, провести final export и Flutter. Никто из этих владельцев
не изменён данным PR.

## Капитану: последовательное принятие PR

Цепочка зависимостей `#1 → #2 → #3 → stage4`. Новая ветка основана на c573d93 (head #3),
base нового Draft PR — `bekzat/contextual-language-quality`. Base существующих PR не
менялся; merge и перевод в Ready автоматически не выполняются.

Капитан проверяет diff и CI точного head #1, принимает его первым, затем проверяет base
и diff #2 и повторяет для #3 и stage4. Перед удалением родительской ветки согласует
retarget оставшегося PR на интеграционную ветку: это действие интегратора. Если выбран
squash merge, отсутствие общей истории может показать повторные изменения в следующем
PR; сначала разрешить это явно, не нажимать merge вслепую. После каждого принятия
проверить CI нового head интеграционной ветки; после сборки всех owner-компонентов
повторить review-smoke и финальный release/Flutter gate. Старый зелёный run не подтверждает
новый SHA и не заменяет реальные решения проверяющих.
