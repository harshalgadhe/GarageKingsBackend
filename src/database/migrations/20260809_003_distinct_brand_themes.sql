UPDATE brands SET
  accent_color = '#D7E1E8', secondary_color = '#F5F7F8', background_color = '#091116',
  theme_variant = 'precision', kicker = 'Street and circuit precision',
  headline = 'Modern machines. Exact proportions.',
  description = 'Contemporary road and race cars selected for crisp proportions, authentic liveries and disciplined presentation.',
  origin_label = 'Hong Kong', style_label = 'Detail-led 1:64'
WHERE slug = 'inno64';

UPDATE brands SET
  accent_color = '#F16B3A', secondary_color = '#F3E1C2', background_color = '#142219',
  theme_variant = 'race', kicker = 'Custom culture, scaled down',
  headline = 'Wild builds. Serious detail.',
  description = 'Expressive custom machines shaped by Jun Imai, presented with the attitude and detail their silhouettes demand.',
  origin_label = 'Mini GT × Jun Imai', style_label = 'Custom JDM'
WHERE slug = 'kaido-house';

UPDATE brands SET
  accent_color = '#E4473D', secondary_color = '#F1F1ED', background_color = '#111111',
  theme_variant = 'grid', kicker = 'Motorsport lives here',
  headline = 'From pit lane to display.',
  description = 'Race-bred replicas and road-going icons catalogued with a focused motorsport perspective.',
  origin_label = 'Hong Kong', style_label = 'Race-bred replicas'
WHERE slug = 'tarmac-works';

UPDATE brands SET
  accent_color = '#5E8FE8', secondary_color = '#D5E2FF', background_color = '#070A10',
  theme_variant = 'grid', kicker = 'Competition specification',
  headline = 'Measured in detail. Defined by performance.',
  description = 'Competition-focused models presented through technical detail, disciplined contrast and race engineering.',
  origin_label = 'Performance models', style_label = 'Race engineering'
WHERE slug = 'hg';

UPDATE brands SET
  accent_color = '#3FAE92', secondary_color = '#B7E2D7', background_color = '#07100D',
  theme_variant = 'neon', kicker = 'Street-built personalities',
  headline = 'Cars with character.',
  description = 'Recognisable custom builds and automotive characters presented with a cinematic street-garage mood.',
  origin_label = 'Custom culture', style_label = 'Street character'
WHERE slug = 'morecar';

UPDATE brands SET background_color = '#170607'
WHERE slug = 'pop-race';
