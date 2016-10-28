import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as _ from 'lodash';

import { Luis } from './luis-model';

export type culture = 'en-us' | 'es-es';

export class LanguageModelParser {
    private doc: any = {};
    public culture: culture;

    parse(files: string[], culture: culture): Luis.Model {
        try {
            files.forEach(file => {
                // XXX Conflicting keys not supported. Multiple files could be merged together.
                let yamlFileContents = fs.readFileSync(file, 'utf8');
                Object.assign(this.doc, yaml.safeLoad(yamlFileContents));
            });
        } catch (err) {
            throw new Error('Not able to parse language model: ' + err);
        }
        this.culture = culture;

        let luisModel: Luis.Model = {
            luis_schema_version: '1.3.0',
            name: 'tef',
            desc: 'Bot Model ' + new Date(),
            culture: culture,
            intents: [],
            entities: [],
            composites: [],
            bing_entities: [],
            actions: [],
            model_features: [],
            regex_features: [],
            utterances: []
        };

        let keys = Object.keys(this.doc);

        let intentNames = keys
            .filter(intentName => !intentName.startsWith('list.'))
            .filter(intentName => !intentName.startsWith('phraselist'))
            .filter(intentName => !intentName.startsWith('builtin'))
            // remove the lists: lines starting by "list." that are not intents
            .map(intentName => {
                if (intentName.length > 50) {
                    throw new Error(`Intent "${intentName}" should be less than 50 characters. was ${intentName.length}`);
                }
                return intentName;
            });

        let replacements = new Map<string, string[]>();
        keys.filter(intentName => intentName.startsWith('list.'))
            .forEach(intentName => {
                replacements.set(
                    intentName.slice('list.${'.length, -1),
                    this.doc[intentName]
                );
            });

        
        let entitiesMap = new Map<string, Luis.Entity>();
        let utterances = new Set<Luis.Utterance>();

        intentNames.forEach(intent => {
            let sentences = this.doc[intent];

            sentences
                .map((sentence: string) => this.expandVariables(sentence, replacements))
                .reduce((a: string[], b: string[]) => a.concat(b)) // flatten arrays
                .forEach((sentence: string) => {
                    let utterance = this.buildUtterance(sentence, intent);
                    utterance.entities.forEach(entity => this.registerEntity(entity, entitiesMap));
                    utterances.add(utterance);
                });
        });

        let features = _.toPairs(this.doc.phraselist)
            .map(value => {
                let name = String(value[0]);
                let activated: boolean = value[1].activated == null ? true : value[1].activated;
                let mode: boolean = value[1].mode == null ? true : value[1].mode;
                let words = (value[1].words || [])
                    .map((word:string) => this.tokenize(word).join(' '))
                    .join(',');
                
                return { 
                    activated,
                    mode, 
                    name,
                    words 
                } as Luis.ModelFeature;
            });
    
        let bingEntities = this.doc.builtin || [];

        luisModel.utterances = Array.from(utterances.values());
        luisModel.entities = Array.from(entitiesMap.values());
        luisModel.intents = intentNames.map(intent => <Luis.Intent>{ name: intent });
        luisModel.model_features = features;
        luisModel.bing_entities = bingEntities;

        return luisModel;
    }

    private expandVariables(sentence: string, variables: Map<string, string[]>): string[] {
        let expandedSentences = new Set([sentence]);
         expandedSentences.forEach(sentence => {
            variables.forEach((values, key) => {
                values.forEach(value => {
                    let search = '${' + key + '}';
                    if (sentence.indexOf(search) !== -1 ) {
                        let newSentence = sentence.replace(search, value);
                        if (newSentence !== sentence) {
                            expandedSentences.add(newSentence);
                            expandedSentences.delete(sentence);
                        } else {
                            expandedSentences.add(sentence);
                        }
                    }
                });
            });
        }); 
        
        return Array.from(expandedSentences);
    }

    private extractEntities(sentence: string): any[] {
        let regexEntity = /\[(.+?):(.+?)\]/g; // entities are tagged as [entityValue:entityType], ex. [Burgos:city]

        let entities: any[] = [];
        let match: RegExpExecArray;

        while (match = regexEntity.exec(sentence)) {
            let entityValue = match[1];
            let entityType = match[2];

            entities.push({
                entityValue,
                entityType
            });
        }

        return entities;
    }

    private registerEntity(entity: any, entitiesMap: Map<string, Luis.Entity>): void {
        let entityType: string = entity.entity;
        let entitySubtype: string;

        let composedEntitySeparatorPosition = entityType.indexOf('::');
        if (composedEntitySeparatorPosition >= 0) {
            entitySubtype = entityType.substring(composedEntitySeparatorPosition + '::'.length);
            entityType = entityType.substring(0, composedEntitySeparatorPosition);
        }

        let luisEntity = entitiesMap.get(entityType);
        luisEntity = luisEntity || { name: entityType };

        if (entitySubtype) {
            luisEntity.children = luisEntity.children || [];
            if (luisEntity.children.indexOf(entitySubtype) === -1) {
                luisEntity.children.push(entitySubtype);
            }
        }

        entitiesMap.set(entityType, luisEntity);

    }

    private normalizeSentence(sentence: string): string {
        let normalized = sentence
            // replace multiple spaces with a single one
            .replace(/\s\s+/g, ' ')
            .trim();

        switch (this.culture) {
            case 'en-us':
                // in an en-us luis app, nothing but ASCII 7 chars are lowercased
                // see test/fixtures/{en-es}-cornercases.yaml
                normalized = normalized.replace(/[A-Z]/g, capture => capture.toLowerCase());
                break;
            default:
                normalized = normalized.toLocaleLowerCase();
        }

        return normalized;
    }

    private wordCount(sentence: string): number {
        return this.tokenize(sentence).length;
    }

    private tokenize(sentence:string): string[] {
        // separate non-word chars the same way MS does (ex. 'a,b,c' -> 'a , b , c')
        return String(sentence)
            // ^\w\u00C0-\u017F means a not word, including accented chars
            // (see http://stackoverflow.com/a/11550799/12388)
            .replace(/[^\w\u00C0-\u017F]/g, capture => ` ${capture} `)
            .replace(/_/g, capture => ` ${capture} `)
            // omit non-word exceptions not handled by microsoft ('º' and 'ª')
            .replace(' º ', 'º')
            .replace(' ª ', 'ª')
            // replace multiple spaces with a single one
            .replace(/\s\s+/g, ' ')
            .trim()
            .split(' ');
    }

    private buildUtterance(sentence: string, intent: string) {

        let entities: any[] = [];
        let parts: string = '';

        sentence
            .trim()
            // split by entities:
            // "Santiago Bernabeu went to [Santiago Bernabeu:place]." will split in
            // [ "Santiago Bernabeu went to ", "[Santiago Bernabeu:place]", "." ]
            .split(/(\[.+?:.+?\])/g)
            .forEach(part => {
                let extractedEntities = this.extractEntities(part);
                if (extractedEntities.length) {
                    extractedEntities.forEach(entity => {
                        let startPos = this.wordCount(parts);
                        parts += entity.entityValue;
                        let endPos = this.wordCount(parts) - 1;
                        entities.push({
                            entity: entity.entityType,
                            startPos,
                            endPos
                        });
                    });
                } else {
                    parts += part;
                }
            });

        let utterance: Luis.Utterance = {
            text: this.normalizeSentence(parts),
            intent,
            entities: entities
        };

        return utterance;
    }
}
