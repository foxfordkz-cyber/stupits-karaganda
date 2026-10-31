// Invented by AI, not copied from Grand Mobile. Coordinator hypotheses are NOT
// ground truth, native ratings, or engine predictions. Do not give this key to
// a blind reviewer before their answers are frozen.
export const humanReviewCases = [
  ['gift_spelling', 'orthography', 'Подарок получен.', 'Сыйлык алынды.', 'Сыйлық алынды.', 'spelling', 'Возможная замена қ на к в слове «сыйлық».'],
  ['correct_original', 'orthography', 'Войти', 'Кіру', 'Шығу', 'false_positive_and_bad_correction', 'Проверить гипотезу о необходимости замены уже корректного перевода.'],
  ['style_dispute', 'machine_translation_suspect', 'Пожалуйста, подождите.', 'Өтінеміз, күтіңіз.', 'Күте тұрыңыз.', 'disputed_style', 'Нужна ли стилистическая замена в данном интерфейсе?'],
  ['static_case', 'suffix_harmony', 'Идите в школу.', 'Мектепға барыңыз.', 'Мектепке барыңыз.', 'morphology', 'Проверить падежное окончание слова «мектеп».'],
  ['dynamic_name', 'suffix_harmony', 'Письмо для {name}', '{name}-ға хат', 'Хат алушы: {name}', 'dynamic_morphology', 'Фиксированное -ға может не подходить ко всем именам.'],
  ['term_policy', 'inconsistent_term', 'Ваш транспорт', 'Сіздің автоңыз', 'Сіздің көлігіңіз', 'terminology_conflict', 'Оба варианта требуют решения о терминологии; отсутствие политики не доказывает ошибку.'],
  ['game_slang', 'wrong_language', 'Игрок получил мут.', 'Ойыншы мут алды.', 'Ойыншының чатқа жазуы шектелді.', 'slang_false_positive_risk', 'Заимствованный игровой термин сам по себе не доказывает неверный язык.'],
  ['negation', 'machine_translation_suspect', 'У вас нет ключа.', 'Сізде кілт бар.', 'Сізде кілт жоқ.', 'semantic_negation', 'Возможно, отрицание заменено утверждением.'],
  ['prohibition', 'machine_translation_suspect', 'Не удаляйте семью.', 'Отбасын жойыңыз.', 'Отбасын жоймаңыз.', 'semantic_prohibition', 'Проверить сохранение запрета.'],
  ['modality', 'machine_translation_suspect', 'Можно войти.', 'Кіруге болмайды.', 'Кіруге болады.', 'semantic_permission', 'Проверить, не заменено ли разрешение запретом.'],
  ['quantity', 'machine_translation_suspect', 'Куплено два билета.', 'Үш билет сатып алынды.', 'Екі билет сатып алынды.', 'semantic_quantity', 'В исходнике два билета, в переводе три.'],
  ['bad_name_loss', 'machine_translation_suspect', 'Привет, {name}!', 'Сәлем, {name}!', 'Сәлем!', 'unsafe_bad_correction', 'Проверить предложение, теряющее обращение к имени; технический gate обязан отклонить его.'],
];
