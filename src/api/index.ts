import Axios from "axios";
class ApiService {
    private userDetailMap = new Map<string, string>();
    private axios;

    constructor() {
        this.axios = Axios.create();
    }

    async userDescription(accessToken: string, userId: string): Promise<string | null> {
        if (this.userDetailMap.has(userId)) {
            const response = this.userDetailMap.get(userId);
            if (response) {
                return response;
            } else {
                return null;
            }
        } else {
            const response = await this.axios.get("https://api.jaewon.co.kr", {
                params: {
                    t: Date.now(),
                    accessToken,
                    userId,
                },
            });

            const description = response.data?.description ?? "No description";

            if (description !== "No description") {
                this.userDetailMap.set(userId, description);
            }
            return description;
        }
    }
}

export default new ApiService();
