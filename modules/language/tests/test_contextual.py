"""Invented examples only: context, unapproved candidates and cache regressions."""
import copy
from pathlib import Path
import tempfile
import unittest

from bekzat_language import analyze
from bekzat_language.contracts import digest, FINDING_FIELDS
from bekzat_language.proposals import text_hash, validate_proposal
from bekzat_language.rules import analyze_record, RULES_VERSION, term_contexts
from bekzat_language.storage import Cache

EMPTY = {'status': 'draft', 'entries': []}


def record(target='Сыйлык {name}', **fields):
    return {'key': 'synthetic', 'source': 'Подарок {name}', 'target': target,
            'locale': 'kk', 'occurrence': 1, 'source_hash': 'a' * 64,
            'category': 'test', **fields}


def glossary(**fields):
    return {'status': 'draft', 'entries': [
        {'id': 'synthetic-brand', 'source_forms': ['Continue'], 'allowed_forms': ['Continue'],
         'preferred': 'Continue', **fields}]}


class ContextualTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache = Path(self.tmp.name) / 'cache'

    def run_records(self, records):
        return analyze(records, EMPTY, cache_dir=self.cache)

    def test_allowed_brand_is_protected(self):
        self.assertEqual(analyze_record(record('Continue', source='Continue'), glossary()), [])

    def test_brand_does_not_hide_surrounding_language(self):
        findings = analyze_record(record('Пожалуйста нажмите Continue',
            source='Нажмите Continue'), glossary())
        self.assertEqual([f['issue_type'] for f in findings], ['wrong_language'])

    def test_allowed_term_requires_source_and_category(self):
        for r in [record('Continue', source='Продолжить'), record('Continue', source='Continue', category='other')]:
            with self.subTest(r=r):
                self.assertEqual(analyze_record(r, glossary(categories=['test']))[0]['issue_type'], 'wrong_language')

    def test_unknown_inflection_is_not_a_glossary_error(self):
        self.assertEqual(analyze_record(record('ойыншыларына', source='игрок'),
            glossary(source_forms=['игрок'], allowed_forms=['ойыншы'], preferred='ойыншы')), [])

    def test_mixed_script_has_exact_unicode_evidence(self):
        result = self.run_records([record('Cыйлық {name}')])
        self.assertEqual(result['findings'][0]['issue_type'], 'orthography')
        self.assertIn('U+0043', result['findings'][0]['evidence'])
        self.assertEqual(result['proposals'][0]['candidate_text'], 'Сыйлық {name}')

    def test_unknown_mixed_script_name_is_not_an_error(self):
        self.assertEqual(analyze_record(record('GrandҚала Aстана X5'), EMPTY), [])

    def test_metadata_neutral_word_is_not_an_error(self):
        self.assertEqual(analyze_record(record('Cыйлық', metadata={'language_neutral_terms': ['Cыйлық']}), EMPTY), [])

    def test_reference_match_keeps_original_locale_in_evidence(self):
        r = record('Choose avatar', source='Выберите аватар',
                   context={'references': {'en-US': 'Choose avatar'}})
        finding = analyze_record(r, EMPTY)[0]
        self.assertEqual(finding['issue_type'], 'wrong_language')
        self.assertIn('references.en-US', finding['evidence'])
        # Just one marker is insufficient without the exact supplementary reference.
        self.assertEqual(analyze_record({**r, 'context': {}}, EMPTY), [])

    def test_reference_brand_or_kazakh_is_not_language_evidence(self):
        for target in ['Grand Mobile', 'Сыйлық алыңыз', 'Confirm']:
            r = record(target, source=target, context={'references': {'en': target}},
                       metadata={'language_neutral': True})
            self.assertEqual(analyze_record(r, EMPTY), [])
        self.assertEqual(analyze_record(record('Grand Mobile', context={'references': {'en': 'Grand Mobile'}}), EMPTY), [])

    def test_email_url_slots_and_tags_are_not_spellchecked(self):
        r = record('https://example.test/сыйлык test+сыйлык@example.test <b title="сыйлык">42</b> {continue} %1$s')
        self.assertEqual(analyze_record(r, EMPTY), [])

    def test_proposal_preserves_markup_placeholders_numbers_newlines(self):
        r = record('<b>Сыйлык</b> {name}: 42 %1$s\nКіру')
        before = copy.deepcopy(r)
        result = self.run_records([r])
        p = result['proposals'][0]
        self.assertEqual(p['candidate_text'], '<b>Сыйлық</b> {name}: 42 %1$s\nКіру')
        self.assertEqual(p['original_target_hash'], text_hash(r['target']))
        self.assertEqual(p['candidate_hash'], text_hash(p['candidate_text']))
        self.assertEqual(p['record_hash'], digest(r))
        self.assertIs(p['reviewed_by_human'], False)
        self.assertEqual(p['technical_validation'], 'pending_core')
        self.assertEqual(r, before)
        self.assertEqual(set(result['findings'][p['finding_index']]), FINDING_FIELDS)

    def test_case_preserved_in_candidates(self):
        for target, expected in [('сыйлык', 'сыйлық'), ('Сыйлык', 'Сыйлық'), ('СЫЙЛЫК', 'СЫЙЛЫҚ')]:
            result = self.run_records([record(target)])
            self.assertEqual(result['proposals'][0]['candidate_text'], expected)

    def test_quoted_greater_than_does_not_expose_tag_attributes(self):
        result = self.run_records([record('<b title="x > сыйлык">Сыйлык</b>')])
        self.assertEqual(len(result['findings']), 1)
        self.assertEqual(result['proposals'][0]['candidate_text'], '<b title="x > сыйлык">Сыйлық</b>')

    def test_proposal_offsets_are_unicode_code_points(self):
        result = self.run_records([record('🎁 Сыйлык')])
        p = result['proposals'][0]
        self.assertEqual(p['replacement']['start'], 2)
        self.assertEqual(p['candidate_text'], '🎁 Сыйлық')

    def test_each_proposal_is_an_independent_span_edit(self):
        result = self.run_records([record('Сыйлык сыйлык')])
        self.assertEqual([p['candidate_text'] for p in result['proposals']], ['Сыйлық сыйлык', 'Сыйлык сыйлық'])
        self.assertEqual([p['finding_index'] for p in result['proposals']], [0, 1])

    def test_complex_or_broken_icu_has_no_candidate(self):
        for target in ['{count, plural, one {Сыйлык} other {Сыйлык}}', '{Сыйлык', '{сыйлык}']:
            with self.subTest(target=target):
                self.assertEqual(self.run_records([record(target)])['proposals'], [])

    def test_suffix_risk_has_no_automatic_rewrite(self):
        self.assertEqual(self.run_records([record('{name}-ға сыйлық')])['proposals'], [])

    def test_proposals_replay_stably_from_cache(self):
        records = [record(), record('Cыйлық', occurrence=2)]
        first, repeat = self.run_records(records), self.run_records(records)
        self.assertEqual(first['proposals'], repeat['proposals'])
        self.assertEqual(first['findings'], repeat['findings'])
        self.assertEqual(repeat['metrics']['local_cache_hits'], 2)
        self.assertEqual(repeat['metrics']['proposals'], 2)
        self.assertEqual(repeat['metrics']['records_with_findings'], 2)

    def test_proposal_indices_include_prior_findings_and_quarantine(self):
        result = self.run_records([{}, record('Continue', key='first'), record()])
        self.assertEqual(result['proposals'][0]['finding_index'], 1)
        self.assertEqual(result['proposals'][0]['input_index'], 2)

    def test_tampered_cached_proposals_are_recomputed(self):
        r = record()
        expected = self.run_records([r])['proposals']
        key = digest({'kind': 'local', 'version': RULES_VERSION, 'record': r, 'glossary': EMPTY})
        with Cache(self.cache) as cache:
            cached = cache.get(key)
            cached['proposals'][0]['reviewed_by_human'] = True
            cache.put(key, cached)
        result = self.run_records([r])
        self.assertEqual(result['metrics']['local_cache_misses'], 1)
        self.assertEqual(result['proposals'], expected)

    def test_proposal_rejects_stale_record_and_modified_candidate(self):
        r, proposals = record(), []
        findings = analyze_record(r, EMPTY, proposals=proposals)
        for changed in [dict(proposals[0], reviewed_by_human=0),
                        dict(proposals[0], candidate_text='arbitrary'),
                        dict(proposals[0], candidate_hash='b' * 64)]:
            with self.assertRaises(ValueError):
                validate_proposal(changed, r, findings)
        with self.assertRaises(ValueError):
            validate_proposal(proposals[0], {**r, 'description': 'changed context'}, findings)

    def test_longest_term_variant_prevents_subphrase_false_conflict(self):
        g = glossary(source_forms=['задание'], allowed_forms=['күнделікті тапсырма'],
                     preferred='күнделікті тапсырма', consistent=True,
                     variants={'күнделікті тапсырма': 'daily', 'тапсырма': 'generic'})
        records = [record('күнделікті тапсырма', source='задание', key=str(n)) for n in range(2)]
        self.assertEqual(term_contexts(records, g)[1], [[], []])
        records[1]['target'] = 'тапсырма'
        self.assertEqual([len(fs) for fs in term_contexts(records, g)[1]], [1, 1])
        records[1]['metadata'] = {'language_neutral': True}
        self.assertEqual(term_contexts(records, g)[1], [[], []])
