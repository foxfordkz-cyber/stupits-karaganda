"""Multi-label scoring by (record occurrence, issue type), with explicit zero denominators."""
from collections import Counter
from .fixtures import ISSUES


def ratios(tp, fp, fn):
    return {'tp': tp, 'fp': fp, 'fn': fn,
            'precision': tp / (tp + fp) if tp + fp else None,
            'recall': tp / (tp + fn) if tp + fn else None,
            'f1': 2 * tp / (2 * tp + fp + fn) if 2 * tp + fp + fn else None}


def score(cases, predictions):
    if len({case['id'] for case in cases}) != len(cases):
        raise ValueError('duplicate benchmark case id')
    expected = set()
    for i, case in enumerate(cases):
        labels = case['expected']
        if not isinstance(labels, list) or len(set(labels)) != len(labels) or set(labels) - set(ISSUES):
            raise ValueError('invalid expected labels')
        expected.update((i, label) for label in labels)
    raw = []
    for prediction in predictions:
        i, label = prediction['input_index'], prediction['issue_type']
        if type(i) is not int or not 0 <= i < len(cases) or label not in ISSUES:
            raise ValueError('invalid prediction identity/type')
        raw.append((i, label))
    actual = set(raw)
    tp, fp, fn = expected & actual, actual - expected, expected - actual
    category = {}
    for issue in ISSUES:
        category[issue] = ratios(sum(t == issue for _, t in tp), sum(t == issue for _, t in fp),
                                 sum(t == issue for _, t in fn))
    confusion = []
    for i, case in enumerate(cases):
        wanted = sorted(t for n, t in expected if n == i)
        got = sorted(t for n, t in actual if n == i)
        if wanted != got:
            confusion.append({'case_id': case['id'], 'expected': wanted, 'predicted': got,
                'missing': sorted(set(wanted) - set(got)), 'unexpected': sorted(set(got) - set(wanted)),
                'rationale': case['rationale']})
    return {'unit': '(case occurrence, issue_type); repeated same-type findings count once',
            'cases': len(cases), 'expected_labels': len(expected), 'predicted_labels': len(actual),
            'micro': ratios(len(tp), len(fp), len(fn)), 'per_category': category,
            'duplicate_predictions': sum(n - 1 for n in Counter(raw).values()),
            'false_positives': [{'case_id': cases[i]['id'], 'issue_type': t} for i, t in sorted(fp)],
            'false_negatives': [{'case_id': cases[i]['id'], 'issue_type': t} for i, t in sorted(fn)],
            'confusion_cases': confusion}
