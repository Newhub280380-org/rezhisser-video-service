# Роутер режиссёра: как выбрать рецепт по запросу

## Алгоритм
1. Определи интент запроса → теги (таблица ниже).
2. Определи, что прислал клиент (inputs): фото товара, фото лица, фото в рост, видео-референс, старт/финал кадры, аудио.
3. Отфильтруй catalog.json: все теги запроса ⊂ intent_tags, inputs рецепта ⊆ доступным файлам.
4. Ранжируй: prompt_completeness complete > partial > gaps; confidence B > B/C > C; меньше шагов с tool=unknown.
5. Если в рецепте есть шаг/промпт `unknown` — не выдумывай: возьми близкий рецепт (duplicates_of) или спроси у клиента недостающий файл.
6. Подставь данные клиента в промпт только в явных местах (Image 1, @Image1, [product] и т.п.); остальной текст промпта не менять.

## Таблица интентов
| Тег | Признаки в запросе | Обязательные inputs | Рецептов | Лучшие (по полноте) |
|---|---|---|---|---|
| client_in_clip | «вставь меня», «по моему фото», подмена героя | фото лица/в рост (+видео-референс) | 114 | 104_self_acting_wan_animate_voice_changer_collage, 088_exploded_view_assembly_nbpro_kling_firstlast, 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 119_viral_whippan_one_take_pet_room_photo_seedance25 |
| seamless_series | длинный бесшовный ролик, переходы, серия | старт/финал кадры или цепочка last frame | 61 | 104_self_acting_wan_animate_voice_changer_collage, 088_exploded_view_assembly_nbpro_kling_firstlast, 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield |
| product_ad | «реклама товара», «ролик для карточки», «UGC» | фото товара | 44 | 088_exploded_view_assembly_nbpro_kling_firstlast, 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 119_viral_whippan_one_take_pet_room_photo_seedance25, 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control |
| talking_head | «чтобы говорил», озвучка, липсинк | фото лица + текст/аудио | 43 | 104_self_acting_wan_animate_voice_changer_collage, 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield, 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control, 144_recurring_character_360_turn_viral_frame_motion_swap |
| motion_transfer | повторить движение из видео | видео-референс + фото персонажа | 35 | 119_viral_whippan_one_take_pet_room_photo_seedance25, 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control, 001_two_performers_swap_seedance_kling, 130_audi_rs6_full_chain_seedream_nbpro_kling_motion_seedance2_capcut |
| animal | питомец, кот, собака | фото питомца | 33 | 119_viral_whippan_one_take_pet_room_photo_seedance25, 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield, 122_meme_or_reality_own_video_plus_kittens_video_seedance25, 053_swap_self_screenshot_nbpro_kling_motion |
| meme | вирусный тренд, мем, смешное | видео-образец тренда или фото | 26 | 088_exploded_view_assembly_nbpro_kling_firstlast, 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 119_viral_whippan_one_take_pet_room_photo_seedance25, 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control |
| vfx_effect | эффект, трансформация | фото/кадр | 26 | 088_exploded_view_assembly_nbpro_kling_firstlast, 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield, 124_food_cgi_ad_llm_nb_llm_seedance25_3shots_6s |
| other | прочее | — | 23 | 123_inside_painting_drawn_trajectory_gemini_template_seedance, 151_super_landing_topdown_kling_keyframes, 067_stopmotion_doll_dressing_fashion_ad, 136_neighbor_peeping_window_zoom_mirror_curtain_seedance25 |
| object_alive | оживить предмет/фото | фото объекта | 22 | 104_self_acting_wan_animate_voice_changer_collage, 200_service_banner_from_selfie_nb_then_veo3_talking_ad, 051_giant_animal_at_home_nb2_kling3, 057_talking_child_greeting_nb_sora_veo |
| pov_one_take | POV, одним дублем, пролёт | фото локации/героя | 17 | 186_techhalla_monument_valley_phone_30s_one_take, 042_film_once_new_world_background_prompts, 111_charsheet_spider_drone_part2_seedance_continuation, 197_own_photo_witch_flight_over_real_city_seedance25 |
| beauty_ad | косметика, духи, крем, уход | фото товара (+лицо) | 13 | 088_exploded_view_assembly_nbpro_kling_firstlast, 109_bag_throw_outfit_transitions_gptimage_seedance, 195_ugc_selfie_cosmetics_russian_speech_seedance25, 196_perfume_ad_from_bottle_photo_seedance25_one_prompt |
| family_photos | семья, старые фото, реставрация | несколько/старые фото | 5 | 100_restore_old_photo_hug_younger_self, 060_rhythm_reference_5_environments_audio_sync, 069_family_adults_to_kids_daisy_field_orbit, 202_old_photo_restore_seedream_then_veo3_fast_hug_two_images |
| dance | танец, хореография | видео-референс танца + фото | 4 | 122_meme_or_reality_own_video_plus_kittens_video_seedance25, 114_dance_video_face_swap_nbpro_seedance_camera_recreate, 148_crowd_replacement_hero_clones_seedance, 112_nightclub_two_people_json_seedance25_partial |

## Таблица по входным файлам
| Что прислал клиент | Рецепты (топ-5) |
|---|---|
| аудио/голос (89) | 104_self_acting_wan_animate_voice_changer_collage, 119_viral_whippan_one_take_pet_room_photo_seedance25, 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield, 144_recurring_character_360_turn_viral_frame_motion_swap, 122_meme_or_reality_own_video_plus_kittens_video_seedance25 |
| стартовый кадр (58) | 088_exploded_view_assembly_nbpro_kling_firstlast, 119_viral_whippan_one_take_pet_room_photo_seedance25, 001_two_performers_swap_seedance_kling, 186_techhalla_monument_valley_phone_30s_one_take, 081_insert_self_into_movie_scene_nbpro_kling_seedance |
| фото лица/портрет человека (46) | 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 119_viral_whippan_one_take_pet_room_photo_seedance25, 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control, 001_two_performers_swap_seedance_kling, 130_audi_rs6_full_chain_seedream_nbpro_kling_motion_seedance2_capcut |
| логотип (46) | 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control, 001_two_performers_swap_seedance_kling, 122_meme_or_reality_own_video_plus_kittens_video_seedance25, 163_zombie_alien_donut_time_freeze_comedy_30s_seedance25, 197_own_photo_witch_flight_over_real_city_seedance25 |
| видео-референс (движение/клип) (42) | 119_viral_whippan_one_take_pet_room_photo_seedance25, 001_two_performers_swap_seedance_kling, 130_audi_rs6_full_chain_seedream_nbpro_kling_motion_seedance2_capcut, 122_meme_or_reality_own_video_plus_kittens_video_seedance25, 053_swap_self_screenshot_nbpro_kling_motion |
| unknown (38) | 109_bag_throw_outfit_transitions_gptimage_seedance, 199_talking_object_character_nbpro_veo31_russian_speech, 041_h3_syncTile_background_replace, 054_slime_face_asmr_nbpro_veo31, 161_stadium_broadcast_capture_photo_edit_then_animate_16x9 |
| фото в полный рост (26) | 144_recurring_character_360_turn_viral_frame_motion_swap, 114_dance_video_face_swap_nbpro_seedance_camera_recreate, 042_film_once_new_world_background_prompts, 142_doll_outfit_change_giant_hand_nb21_first_last_seedance25, 007_minimax_h3_fl2va_sam3_silhouette_dialogue |
| финальный кадр (19) | 088_exploded_view_assembly_nbpro_kling_firstlast, 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield, 100_restore_old_photo_hug_younger_self, 142_doll_outfit_change_giant_hand_nb21_first_last_seedance25, 145_fruit_drama_talking_characters_cliffhanger_start_frames_veo_kling |
| фото товара/продукта (18) | 088_exploded_view_assembly_nbpro_kling_firstlast, 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot, 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control, 181_your_photo_character_sheet_nbpro_remake_into_trend_reel_veoseebot, 098_kling40_one_prompt_talking_product_ugc |
| фото локации/города (8) | 119_viral_whippan_one_take_pet_room_photo_seedance25, 125_family_cartoon_pixar_nb_gemini_script_seedance25, 156_bullet_time_fashion_hero_object_seedance, 191_ivanka_humeniuk_romantic_dramedy_12_maps_6x30s_seedance, 207_drawn_camera_path_universal_prompt_loop_closure_seedance25 |
| фото питомца (3) | 119_viral_whippan_one_take_pet_room_photo_seedance25, 091_pet_replaces_human_keep_audio_seedance25, 140_little_knight_pet_and_person_seedance25_20s_4x3 |
| старое фото (2) | 100_restore_old_photo_hug_younger_self, 202_old_photo_restore_seedream_then_veo3_fast_hug_two_images |

## Топ-10 универсальных рецептов
- 104_self_acting_wan_animate_voice_changer_collage — Сыграть сцену самому → герой с фото повторяет игру (Wan Animate) → смена голоса ElevenLabs; + коллаж-метод для второго персонажа, ракурсы через Nano Banana, экшен Kling 2.5, апскейл Topaz
- 088_exploded_view_assembly_nbpro_kling_firstlast — Разбор объекта на детали и обратная сборка (exploded view → сборка)
- 182_two_looks_plain_to_transformed_cards_remake_trend_reel_veoseebot — Трансформация «обычная ↔ образ» в трендовом рилсе: два портрета Nano Banana Pro (обычный + демон / Веном / ангел-демон) → VeoSeeBot Remake по ссылке на рилс
- 119_viral_whippan_one_take_pet_room_photo_seedance25 — Вирусный «один дубль с резкими сменами ракурсов под бит» с вашим питомцем/товаром: видео-референс + фото героя + фото комнаты → Seedance 2.5 Omni
- 168_soul_id_character_into_hollywood_scenes_seedance2_4k_higgsfield — Себя в голливудские сцены: обучить персонажа Soul ID (≈20 фото) в Higgsfield → вызывать его как элемент в Seedance 2.0 4K (5 сцен с промптами)
- 203_cartoon_character_x_brand_sneaker_ad_nbpro_kling3_motion_control — Рекламный ролик «персонаж × бренд» (Tom × Puma): Nano Banana Pro — стабильный персонаж в одежде бренда → отдельно чистое фото продукта → Kling 3.0 Motion Control, 15 с селфи-ролик с диалогом и смешной концовкой («Tom! Come here!» — «Coming, Mom. Bye.») → сборка в InVideo AI
- 001_two_performers_swap_seedance_kling — Подмена двух исполнителей в вирусном клипе (Hotel Lobby): 2 фото + видео-референс
- 130_audi_rs6_full_chain_seedream_nbpro_kling_motion_seedance2_capcut — Полная цепочка «я + моя машина» (шаг 4 теперь открыт): Seedream 4.5 модельный лист → Nano Banana Pro съёмка с авто → Kling Motion по видео-референсу → Seedance 2 (2×10 с) → CapCut
- 144_recurring_character_360_turn_viral_frame_motion_swap — Постоянный персонаж для рилсов: 3 ярких черты → Nano Banana Pro лицо и лист → 360°-поворот → кадр из вирусного ролика 1M+ → Motion Control-подмена
- 122_meme_or_reality_own_video_plus_kittens_video_seedance25 — «Мем или реальность»: своё живое видео с речью (@Video1) + видео котят (@Video2) + лицо → Seedance 2.5 16 с, смешная концовка
