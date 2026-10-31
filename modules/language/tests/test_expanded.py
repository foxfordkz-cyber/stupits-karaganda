"""Synthetic regression cases for v1.3; no supplied translations or real API calls."""
import copy
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from bekzat_language import analyze
from bekzat_language.contracts import canonical, digest
from bekzat_language.model_context import select_glossary
from bekzat_language.provider import build_request, validate_config
from bekzat_language.rules import analyze_record

EMPTY = {'status': 'draft', 'entries': []}


def record(target, **fields):
    return {'key': 'synthetic', 'locale': 'kk', 'source': 'Подарок игроку',
            'target': target, 'category': 'test', 'occurrence': 1, 'source_hash': 'a' * 64, **fields}


def term(identifier, source, target, **fields):
    return {'id': identifier, 'source_forms': [source], 'allowed_forms': [target],
            'preferred': target, **fields}


def config(**fields):
    return {'command': [sys.executable, 'synthetic-adapter.py'], 'provider_id': 'test',
            'model_id': 'synthetic', 'revision': '1', 'max_output_tokens': 100,
            'input_usd_per_million': 1, 'output_usd_per_million': 2, 'timeout_seconds': 5, **fields}


class ExpandedLanguageTests(unittest.TestCase):
    def issues(self, target, **fields):
        return analyze_record(record(target, **fields), EMPTY)

    def test_foreign_sentence_after_kazakh_is_found_with_offsets(self):
        target = 'Қош келдіңіз! Please click continue.'
        findings = self.issues(target)
        self.assertEqual([f['issue_type'] for f in findings], ['wrong_language'])
        span = 'Please click continue'
        start = target.index(span)
        self.assertIn(f'[{start}:{start + len(span)}]', findings[0]['evidence'])
        self.assertIn(span, findings[0]['evidence'])

    def test_russian_and_uzbek_fragments_can_both_be_found(self):
        findings = self.issues('Сәлем! Пожалуйста нажмите продолжить. Iltimos tugmasini bosing.')
        self.assertEqual(len(findings), 2)
        self.assertTrue(all(f['issue_type'] == 'wrong_language' for f in findings))

    def test_newline_and_semicolon_are_fragment_boundaries(self):
        for separator in ['\n', ';', ':']:
            with self.subTest(separator=separator):
                self.assertEqual(len(self.issues('Сыйлық' + separator + 'Please click continue')), 1)

    def test_whole_string_finding_is_not_duplicated_by_fragment_scan(self):
        self.assertEqual(len(self.issues('Please click continue. Select your reward.')), 1)

    def test_single_brand_or_unfamiliar_latin_word_is_not_a_fragment_error(self):
        for target in ['Қош келдіңіз! Grand Mobile.', 'Сәлем! Continue.', 'Сыйлық! Bonus gold.']:
            self.assertEqual(self.issues(target), [])

    def test_explicit_neutral_phrase_is_protected_in_a_mixed_string(self):
        self.assertEqual(self.issues('Сәлем! Please Click!',
            metadata={'language_neutral_terms': ['Please Click']}), [])

    def test_urls_attributes_and_email_do_not_create_fragment_findings(self):
        self.assertEqual(self.issues('Сәлем! <b title="Please click continue.">Бонус</b> '
            'https://example.test/please.click.continue please.click@continue.test'), [])

    def test_kazakh_words_inside_fragment_prevent_lexical_guess(self):
        self.assertEqual(self.issues('Please click үшін батырманы басыңыз'), [])

    def test_printf_and_formatted_icu_suffix_risks(self):
        for token in ['%s', '%1$s', '%02d', '%2$*3$.2f', '{count, number}',
                      '{count, number, ::currency/KZT}', '{when, date, short}', '{when, time}']:
            with self.subTest(token=token):
                target = token + '-ға сыйлық'
                findings = self.issues(target)
                self.assertEqual([f['issue_type'] for f in findings], ['suffix_harmony'])
                self.assertIn(token + '-ға', findings[0]['evidence'])
                self.assertIn(token, findings[0]['suggestion'])

    def test_no_suffix_or_separate_word_does_not_trigger(self):
        for target in ['%s сыйлық', '%d', '{count, number}: 42', '{name} да келді']:
            self.assertEqual(self.issues(target), [])

    def test_literal_escaped_percent_has_no_dynamic_suffix(self):
        for target in ['%%-ға', '%%s-ға', '%%1$s-ға']:
            self.assertEqual(self.issues(target), [])
        self.assertEqual(len(self.issues('%%%s-ға')), 1)

    def test_runtime_morphology_suppresses_only_declared_slot(self):
        target = '%1$s-ға {count, number}-ге'
        findings = self.issues(target, metadata={'placeholders': {'%1$s': {'suffix_handled_by_runtime': True}}})
        self.assertEqual(len(findings), 1)
        self.assertIn('{count, number}', findings[0]['evidence'])
        self.assertEqual(self.issues(target, metadata={'placeholders': {
            '%1$s': {'suffix_handled_by_runtime': True}, 'count': {'suffix_handled_by_runtime': True}}}), [])

    def test_suffix_like_text_in_markup_and_urls_is_not_user_text(self):
        self.assertEqual(self.issues('<b title="{name}-ға">Сыйлық</b> https://example.test/%s-ға'), [])

    def test_quoted_icu_literal_is_not_a_live_slot(self):
        for target in ["'{name}-ға'", "'{name}'ға", "'{count, number}'-ге"]:
            self.assertEqual(self.issues(target), [])

    def test_doubled_apostrophe_does_not_quote_a_live_slot(self):
        self.assertEqual([f['issue_type'] for f in self.issues("''{name}-ға''")], ['suffix_harmony'])

    def test_risks_never_create_automatic_candidates(self):
        with tempfile.TemporaryDirectory() as directory:
            result = analyze([record('%s-ға {count, number}-ге')], EMPTY, cache_dir=directory)
            self.assertEqual(len(result['findings']), 2)
            self.assertEqual(result['proposals'], [])


class ModelContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / 'cache'
        self.glossary = {'status': 'draft', 'entries': [
            term('player', 'игрок', 'ойыншы', forbidden_forms={'ойнаушы': 'ойыншы'}),
            term('quest', 'задание', 'тапсырма'),
            term('vehicle', 'машина', 'көлік', categories=['garage'])]}

    def test_full_glossary_is_default_and_unchanged(self):
        original = copy.deepcopy(self.glossary)
        request = build_request(record('Сыйлық'), self.glossary, [], config())
        self.assertEqual(request['glossary'], original)
        self.assertEqual(self.glossary, original)
        self.assertEqual(request['glossary_selection']['mode'], 'full')
        self.assertEqual(request['glossary_selection']['omitted_entries'], 0)

    def test_relevant_selects_source_target_description_and_witnesses(self):
        examples = [
            (record('Сыйлық', source='Игрок'), [], 'player'),
            (record('Ойнаушы'), [], 'player'),
            (record('Сыйлық', description='Экран: задание'), [], 'quest'),
            (record('Сыйлық', context={'description': 'задание'}), [], 'quest'),
            (record('Сыйлық', context='задание'), [], 'quest'),
            (record('Сыйлық'), [{'concept': 'quest', 'witnesses': []}], 'quest'),
        ]
        for r, witnesses, expected in examples:
            with self.subTest(r=r):
                selected, audit = select_glossary(r, self.glossary, witnesses, 'relevant')
                self.assertEqual([e['id'] for e in selected['entries']], [expected])
                self.assertEqual(audit['selected_entries'], 1)
                self.assertEqual(audit['full_glossary_hash'], digest(self.glossary))

    def test_category_and_word_boundaries_are_respected(self):
        selected, _ = select_glossary(record('көлік', source='игроками машина'), self.glossary, [], 'relevant')
        self.assertEqual(selected['entries'], [])
        selected, _ = select_glossary(record('көлік', source='машина', category='garage'), self.glossary, [], 'relevant')
        self.assertEqual([e['id'] for e in selected['entries']], ['vehicle'])

    def test_empty_selection_preserves_draft_status_and_omission_count(self):
        selected, audit = select_glossary(record('Бонус'), self.glossary, [], 'relevant')
        self.assertEqual(selected['status'], 'draft')
        self.assertEqual(selected['entries'], [])
        self.assertEqual(audit['omitted_entries'], 3)

    def test_invalid_scope_is_rejected(self):
        for value in ['auto', '', None, [], 1]:
            with self.assertRaises(ValueError):
                validate_config(config(glossary_scope=value))

    def test_relevant_request_is_smaller_without_claiming_measured_tokens(self):
        g = {'status': 'draft', 'entries': [term(f't{i}', f'термин{i}', f'атау{i}') for i in range(150)]}
        r = record('атау3', source='термин3')
        full = build_request(r, g, [], config())
        selected = build_request(r, g, [], config(glossary_scope='relevant'))
        self.assertEqual(selected['glossary_selection']['selected_entries'], 1)
        self.assertLess(len(canonical(selected).encode('utf-8')), len(canonical(full).encode('utf-8')) / 2)
        self.assertLess(selected['input_token_limit'], full['input_token_limit'])

    def test_zero_budget_forecasts_uncached_work_without_charges(self):
        with patch('bekzat_language.engine.call_provider') as provider:
            result = analyze([record('Бонус')], self.glossary, cache_dir=self.cache,
                             provider=config(glossary_scope='relevant'))
        provider.assert_not_called()
        metrics = result['metrics']
        forecast = metrics['budget_forecast']
        self.assertEqual(forecast['uncached_records'], 1)
        self.assertGreater(forecast['uncached_reserved_tokens'], 100)
        self.assertGreater(forecast['uncached_reserved_cost_usd'], 0)
        self.assertEqual(metrics['cost_usd_total'], 0)
        self.assertEqual(metrics['status'], 'partial')
        self.assertEqual(result['events'][0]['glossary_selection']['omitted_entries'], 3)

    def test_cached_model_work_is_excluded_from_forecast(self):
        cfg = config(glossary_scope='relevant')
        response = {'issues': [], 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        with patch('bekzat_language.engine.call_provider', return_value=response) as provider:
            analyze([record('Бонус')], self.glossary, cache_dir=self.cache, provider=cfg,
                    max_requests=1, max_tokens=1_000_000, max_cost_usd=1)
            result = analyze([record('Бонус')], self.glossary, cache_dir=self.cache, provider=cfg)
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(result['metrics']['model_cache_hits'], 1)
        self.assertEqual(result['metrics']['budget_forecast']['uncached_reserved_tokens'], 0)
        self.assertEqual(result['metrics']['budget_forecast']['uncached_reserved_cost_usd'], 0)

    def test_changed_omitted_term_invalidates_model_cache(self):
        cfg = config(glossary_scope='relevant')
        response = {'issues': [], 'usage': {'input_tokens': 10, 'output_tokens': 5}}
        with patch('bekzat_language.engine.call_provider', return_value=response) as provider:
            analyze([record('Бонус')], self.glossary, cache_dir=self.cache, provider=cfg,
                    max_requests=1, max_tokens=1_000_000, max_cost_usd=1)
            changed = copy.deepcopy(self.glossary)
            changed['entries'][0]['comment'] = 'Synthetic revision'
            result = analyze([record('Бонус')], changed, cache_dir=self.cache, provider=cfg)
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(result['metrics']['model_cache_hits'], 0)
        self.assertEqual(result['metrics']['budget_forecast']['uncached_records'], 1)
