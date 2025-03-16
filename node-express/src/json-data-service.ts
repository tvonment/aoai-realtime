import fs from 'fs/promises';
import path from 'path';

// Define types for our sculpture data
export interface Artist {
    id: string;
    name: string;
    birthYear?: string;
    deathYear?: string;
    nationality?: string;
    bio?: string;
}

export interface Material {
    id: string;
    name: string;
    properties?: string;
    uses?: string;
}

export interface Period {
    id: string;
    name: string;
    startYear?: string;
    endYear?: string;
    characteristics?: string;
}

export interface Location {
    id: string;
    name: string;
    city?: string;
    country?: string;
}

export interface Sculpture {
    id: string;
    name: string;
    artist: string; // artist ID or name
    year?: string;
    material?: string; // material ID or name
    period?: string; // period ID or name
    location?: string; // location ID or name
    description?: string;
    imageUrl?: string; // URL to openly available image
    visualDescription?: string; // Detailed visual description for accessibility
}

export interface SculptureData {
    sculptures: Sculpture[];
    artists: Artist[];
    materials: Material[];
    periods: Period[];
    locations: Location[];
}

export class JsonDataService {
    private data: SculptureData | null = null;
    private dataPath: string;

    constructor(dataPath: string) {
        this.dataPath = dataPath;
    }

    async loadData(): Promise<boolean> {
        try {
            const fileContent = await fs.readFile(this.dataPath, 'utf-8');
            this.data = JSON.parse(fileContent);
            return true;
        } catch (error) {
            console.error('Error loading sculpture data:', error);
            return false;
        }
    }

    // Find a sculpture by name or partial name
    async findSculptureByName(name: string): Promise<Sculpture[]> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        const namePattern = name.toLowerCase();
        return this.data.sculptures.filter(sculpture =>
            sculpture.name.toLowerCase().includes(namePattern)
        );
    }

    // Get details about a specific sculpture by ID
    async getSculptureById(id: string): Promise<Sculpture | null> {
        if (!this.data) await this.loadData();
        if (!this.data) return null;

        return this.data.sculptures.find(sculpture => sculpture.id === id) || null;
    }

    // Get sculptures by artist
    async getSculpturesByArtist(artistName: string): Promise<Array<{ sculpture: Sculpture, artist: Artist }>> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        const artistNamePattern = artistName.toLowerCase();

        // Find artists matching the pattern
        const matchingArtists = this.data.artists.filter(artist =>
            artist.name.toLowerCase().includes(artistNamePattern)
        );

        const results: Array<{ sculpture: Sculpture, artist: Artist }> = [];

        // Find sculptures by these artists
        for (const artist of matchingArtists) {
            const artistSculptures = this.data.sculptures.filter(sculpture =>
                sculpture.artist === artist.id || sculpture.artist === artist.name
            );

            for (const sculpture of artistSculptures) {
                results.push({ sculpture, artist });
            }
        }

        return results;
    }

    // Get sculptures by material
    async getSculpturesByMaterial(materialName: string): Promise<Array<{ sculpture: Sculpture, material: Material }>> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        const materialNamePattern = materialName.toLowerCase();

        // Find materials matching the pattern
        const matchingMaterials = this.data.materials.filter(material =>
            material.name.toLowerCase().includes(materialNamePattern)
        );

        const results: Array<{ sculpture: Sculpture, material: Material }> = [];

        // Find sculptures by these materials
        for (const material of matchingMaterials) {
            const materialSculptures = this.data.sculptures.filter(sculpture =>
                sculpture.material === material.id || sculpture.material === material.name
            );

            for (const sculpture of materialSculptures) {
                results.push({ sculpture, material });
            }
        }

        return results;
    }

    // Get sculptures by period
    async getSculpturesByPeriod(periodName: string): Promise<Array<{ sculpture: Sculpture, period: Period }>> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        const periodNamePattern = periodName.toLowerCase();

        // Find periods matching the pattern
        const matchingPeriods = this.data.periods.filter(period =>
            period.name.toLowerCase().includes(periodNamePattern)
        );

        const results: Array<{ sculpture: Sculpture, period: Period }> = [];

        // Find sculptures by these periods
        for (const period of matchingPeriods) {
            const periodSculptures = this.data.sculptures.filter(sculpture =>
                sculpture.period === period.id || sculpture.period === period.name
            );

            for (const sculpture of periodSculptures) {
                results.push({ sculpture, period });
            }
        }

        return results;
    }

    // Search sculptures by multiple criteria
    async searchSculptures(params: {
        name?: string;
        artist?: string;
        material?: string;
        period?: string;
        location?: string;
    }): Promise<Sculpture[]> {
        if (!this.data) await this.loadData();
        if (!this.data) return [];

        return this.data.sculptures.filter(sculpture => {
            // Check name match if provided
            if (params.name && !sculpture.name.toLowerCase().includes(params.name.toLowerCase())) {
                return false;
            }

            // Check artist match if provided
            if (params.artist) {
                const artistMatch = this.data?.artists.find(artist =>
                    artist.id === sculpture.artist || artist.name === sculpture.artist
                );
                if (!artistMatch || !artistMatch.name.toLowerCase().includes(params.artist.toLowerCase())) {
                    return false;
                }
            }

            // Check material match if provided
            if (params.material) {
                const materialMatch = this.data?.materials.find(material =>
                    material.id === sculpture.material || material.name === sculpture.material
                );
                if (!materialMatch || !materialMatch.name.toLowerCase().includes(params.material.toLowerCase())) {
                    return false;
                }
            }

            // Check period match if provided
            if (params.period) {
                const periodMatch = this.data?.periods.find(period =>
                    period.id === sculpture.period || period.name === sculpture.period
                );
                if (!periodMatch || !periodMatch.name.toLowerCase().includes(params.period.toLowerCase())) {
                    return false;
                }
            }

            // Check location match if provided
            if (params.location) {
                const locationMatch = this.data?.locations.find(location =>
                    location.id === sculpture.location || location.name === sculpture.location
                );
                if (!locationMatch || !locationMatch.name.toLowerCase().includes(params.location.toLowerCase())) {
                    return false;
                }
            }

            // If all checks pass, include the sculpture in results
            return true;
        });
    }

    // Helper methods to get entity details
    async getArtistById(id: string): Promise<Artist | null> {
        if (!this.data) await this.loadData();
        return this.data?.artists.find(artist => artist.id === id) || null;
    }

    async getMaterialById(id: string): Promise<Material | null> {
        if (!this.data) await this.loadData();
        return this.data?.materials.find(material => material.id === id) || null;
    }

    async getPeriodById(id: string): Promise<Period | null> {
        if (!this.data) await this.loadData();
        return this.data?.periods.find(period => period.id === id) || null;
    }

    async getLocationById(id: string): Promise<Location | null> {
        if (!this.data) await this.loadData();
        return this.data?.locations.find(location => location.id === id) || null;
    }
}